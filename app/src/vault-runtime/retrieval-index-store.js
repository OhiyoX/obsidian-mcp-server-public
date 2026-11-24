// M2 — crash-safe generation store for the v2 retrieval index (plan 02 Task 2).
//
// Layout, derived only from the legacy index path of one Vault:
//   <index dir>/retrieval-index-v2/current.json          published pointer
//   <index dir>/retrieval-index-v2/manifests/<sha>.json   immutable manifests
//   <index dir>/retrieval-index-v2/objects/<sha>.f32      immutable per-note shards
//
// Publication order is object -> manifest -> pointer, each written to a private
// staging file, fsynced and renamed. A reader therefore sees the whole previous
// generation or the whole new one; a crash leaves orphan staging files that the
// next commit overwrites or `prune()` removes.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { decodeVectorShard, encodeVectorShard, validateManifest } from "./retrieval-index-codec.js";
import { vectorNorm } from "./retrieval-vector-math.js";

const POINTER_VERSION = 1;

function fail(detail) {
  throw new Error(`vault-runtime/retrieval-index-store: ${detail}`);
}

async function syncFile(file) {
  const handle = await fs.open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDir(directory) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * `io.before(step, detail)` is a test seam for fault injection: step names are
 * `object:write`, `manifest:write`, `pointer:write` and `pointer:sync`. Throwing
 * there simulates a crash at that exact point; production passes no `io`.
 */
export function openIndexStore(input = {}) {
  const legacyIndexPath = input.legacyIndexPath;
  if (typeof legacyIndexPath !== "string" || legacyIndexPath === "" || legacyIndexPath.includes("\0")) {
    fail("legacyIndexPath must be a non-empty path string");
  }
  const io = input.io ?? {};
  if (io.before !== undefined && typeof io.before !== "function") fail("io.before must be a function when provided");
  const log = input.log ?? console;
  if (log === null || typeof log !== "object" || typeof log.error !== "function") fail("log must be a console-like object with an error() method");
  // Opportunistic housekeeping: a refresh that changes one note still writes a whole
  // manifest (~21 MB on production data), so orphans must be collected without an
  // operator. At most once per hour, and only objects/manifests older than the window.
  const PRUNE_INTERVAL_MS = input.pruneIntervalMs ?? 60 * 60 * 1000;
  const PRUNE_MIN_AGE_MS = input.pruneMinAgeMs ?? 60 * 60 * 1000;
  let lastPruneAt = 0;
  const before = async (step, detail) => {
    if (io.before) await io.before(step, detail);
  };

  const root = path.join(path.dirname(legacyIndexPath), "retrieval-index-v2");
  const currentPath = path.join(root, "current.json");
  const manifestDir = path.join(root, "manifests");
  const objectDir = path.join(root, "objects");
  const objectPath = (sha) => path.join(objectDir, `${sha}.f32`);
  const manifestPath = (sha) => path.join(manifestDir, `${sha}.json`);

  async function writeAtomic(file, bytes, step) {
    const temp = `${file}.${randomUUID()}.tmp`;
    await before(step, { file, temp, bytes: bytes.length });
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
      await fs.writeFile(temp, bytes);
      await syncFile(temp);
      await fs.rename(temp, file);
      await syncDir(path.dirname(file));
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }

  async function exists(file) {
    return fs.stat(file).then(() => true, () => false);
  }

  async function readPointer() {
    const text = await fs.readFile(currentPath, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (text === null) return null;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      fail(`current.json is not valid JSON: ${error.message}`);
    }
    if (parsed === null || typeof parsed !== "object" || parsed.version !== POINTER_VERSION) fail("current.json has an unsupported version");
    if (typeof parsed.active !== "string" || !/^[0-9a-f]{64}$/u.test(parsed.active)) fail("current.json active must be a sha256 digest");
    if (parsed.previous !== null && (typeof parsed.previous !== "string" || !/^[0-9a-f]{64}$/u.test(parsed.previous))) fail("current.json previous must be null or a sha256 digest");
    return { version: POINTER_VERSION, active: parsed.active, previous: parsed.previous ?? null };
  }

  async function readManifest(sha) {
    const file = manifestPath(sha);
    const text = await fs.readFile(file, "utf8").catch((error) => {
      if (error?.code === "ENOENT") fail(`manifest ${sha} referenced by current.json is missing`);
      throw error;
    });
    const digest = createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
    if (digest !== sha) fail(`manifest ${sha} content digest is ${digest}`);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      fail(`manifest ${sha} is not valid JSON: ${error.message}`);
    }
    return validateManifest(parsed);
  }

  /** Returns the published state, or null when this Vault has no v2 generation yet. */
  async function load() {
    const pointer = await readPointer();
    if (pointer === null) return null;
    const manifest = await readManifest(pointer.active);
    const notes = {};
    for (const entry of manifest.notes) {
      let vectors = [];
      let dimension = entry.dimension;
      if (entry.vectorObject !== null) {
        const bytes = await fs.readFile(objectPath(entry.vectorObject)).catch((error) => {
          if (error?.code === "ENOENT") fail(`object ${entry.vectorObject} for ${JSON.stringify(entry.path)} is missing`);
          throw error;
        });
        const decoded = decodeVectorShard(bytes, { sha256: entry.vectorObject, dimension: entry.dimension });
        vectors = decoded.vectors;
        dimension = decoded.dimension;
      }
      notes[entry.path] = {
        path: entry.path,
        revision: entry.revision,
        stat: entry.stat,
        metadata: entry.metadata,
        chunks: entry.chunks.map((chunk) => ({
          id: chunk.id,
          ordinal: chunk.ordinal,
          heading: chunk.heading,
          text: chunk.text,
          hash: chunk.hash,
          embedding: chunk.vectorIndex === null ? undefined : vectors[chunk.vectorIndex],
          // Derived once per generation: ranking reuses it instead of recomputing 17k norms.
          norm: chunk.vectorIndex === null ? undefined : vectorNorm(vectors[chunk.vectorIndex]),
        })),
      };
      if (dimension === 0 && entry.vectorObject !== null) fail(`object ${entry.vectorObject} decodes to zero vectors`);
    }
    return { version: 2, updatedAt: manifest.updatedAt, embeddingModel: manifest.modelIdentity, notes, generation: pointer.active };
  }

  /**
   * Publishes `nextState`. Notes outside `changedPaths` reuse the previous
   * manifest entry verbatim: no encode, no object write. Returns what it wrote.
   */
  async function commit(nextState, changedPaths = []) {
    if (nextState === null || typeof nextState !== "object" || nextState.notes === null || typeof nextState.notes !== "object") {
      fail("commit needs a state object with a notes map");
    }
    const changed = new Set(changedPaths);
    const pointer = await readPointer();
    const previous = pointer === null ? null : await readManifest(pointer.active);
    const reusable = new Map();
    if (previous !== null && previous.modelIdentity === (nextState.embeddingModel ?? null)) {
      for (const entry of previous.notes) if (!changed.has(entry.path)) reusable.set(entry.path, entry);
    }
    let objectsWritten = 0;
    let objectBytes = 0;
    const manifestNotes = [];
    for (const note of Object.values(nextState.notes)) {
      const reused = reusable.get(note.path);
      if (reused !== undefined && reused.revision === note.revision) {
        manifestNotes.push(reused);
        continue;
      }
      const encoded = encodeVectorShard(note, nextState.embeddingModel ?? "unknown");
      if (encoded.vectorIndexByChunkId.size !== encoded.count) fail(`chunk id collision while encoding ${JSON.stringify(note.path)}`);
      let vectorObject = null;
      if (encoded.count > 0) {
        vectorObject = encoded.sha256;
        const file = objectPath(vectorObject);
        if (!(await exists(file))) {
          await writeAtomic(file, encoded.bytes, "object:write");
          objectsWritten += 1;
          objectBytes += encoded.bytes.length;
        }
      }
      manifestNotes.push({
        path: note.path,
        revision: note.revision,
        stat: note.stat ?? null,
        metadata: note.metadata ?? null,
        dimension: encoded.dimension,
        vectorObject,
        chunks: note.chunks.map((chunk) => ({
          id: chunk.id,
          heading: chunk.heading,
          text: chunk.text,
          hash: chunk.hash,
          vectorIndex: encoded.vectorIndexByChunkId.has(chunk.id) ? encoded.vectorIndexByChunkId.get(chunk.id) : null,
        })),
      });
    }
    manifestNotes.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    const manifest = validateManifest({
      format: "v2",
      modelIdentity: nextState.embeddingModel ?? null,
      updatedAt: nextState.updatedAt ?? new Date().toISOString(),
      notes: manifestNotes,
    });
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
    const manifestSha = createHash("sha256").update(manifestBytes).digest("hex");
    const manifestFile = manifestPath(manifestSha);
    if (!(await exists(manifestFile))) await writeAtomic(manifestFile, manifestBytes, "manifest:write");
    const nextPointer = { version: POINTER_VERSION, active: manifestSha, previous: pointer?.active ?? null };
    const pointerBytes = Buffer.from(`${JSON.stringify(nextPointer)}\n`, "utf8");
    await before("pointer:write", { file: currentPath });
    const temp = `${currentPath}.${randomUUID()}.tmp`;
    await fs.mkdir(root, { recursive: true });
    try {
      await fs.writeFile(temp, pointerBytes);
      await syncFile(temp);
      await before("pointer:sync", { file: currentPath });
      await fs.rename(temp, currentPath);
      await syncDir(root);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
    let pruned = null;
    // `pruneIntervalMs: 0` prunes on every commit (tests); `Infinity` disables it.
    if (Date.now() - lastPruneAt >= PRUNE_INTERVAL_MS) {
      lastPruneAt = Date.now();
      // Never let housekeeping fail a published commit.
      pruned = await prune({ minAgeMs: PRUNE_MIN_AGE_MS }).catch((error) => {
        log.error("Retrieval index prune failed:", error.message);
        return null;
      });
    }
    return {
      generation: manifestSha,
      previous: nextPointer.previous,
      pruned,
      notes: manifest.notes.length,
      chunks: manifest.notes.reduce((sum, note) => sum + note.chunks.length, 0),
      objectsWritten,
      objectBytes,
      manifestBytes: manifestBytes.length,
    };
  }

  /**
   * Removes objects and manifests that no published or previous generation
   * references and that are older than `minAgeMs`. Orphans are kept rather than
   * guessed at: only files this store names are considered.
   */
  async function prune({ minAgeMs = 60 * 60 * 1000 } = {}) {
    const pointer = await readPointer();
    // With no pointer nothing is published, so every object and manifest is an orphan;
    // the age window still protects a commit that is staging right now.
    const keep = new Set([pointer?.active, pointer?.previous].filter((sha) => typeof sha === "string"));
    const referencedObjects = new Set();
    for (const sha of keep) {
      const manifest = await readManifest(sha);
      for (const note of manifest.notes) if (note.vectorObject !== null) referencedObjects.add(note.vectorObject);
    }
    const now = Date.now();
    let objectsRemoved = 0;
    let manifestsRemoved = 0;
    let agesSkipped = 0;
    for (const [directory, pattern, isReferenced, kind] of [
      [objectDir, /^([0-9a-f]{64})\.f32$/u, (sha) => referencedObjects.has(sha), "object"],
      [manifestDir, /^([0-9a-f]{64})\.json$/u, (sha) => keep.has(sha), "manifest"],
    ]) {
      // A missing directory is normal; any other failure must stay visible.
      const entries = await fs.readdir(directory).catch((error) => {
        if (error?.code === "ENOENT") return [];
        throw error;
      });
      for (const entry of entries) {
        const match = pattern.exec(entry);
        if (!match) continue;
        if (isReferenced(match[1])) continue;
        const file = path.join(directory, entry);
        const stat = await fs.stat(file).catch((error) => {
          if (error?.code === "ENOENT") return null;
          throw error;
        });
        if (stat === null) continue;
        if (now - stat.mtimeMs < minAgeMs) {
          agesSkipped += 1;
          continue;
        }
        await fs.rm(file, { force: true });
        if (kind === "object") objectsRemoved += 1;
        else manifestsRemoved += 1;
      }
    }
    return { objectsRemoved, manifestsRemoved, agesSkipped };
  }

  return Object.freeze({ root, currentPath, load, commit, prune });
}
