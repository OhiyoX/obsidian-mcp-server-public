// B1 — root-bound filesystem service (contract §10, §10.2 per-runtime mutation lock, §43-5, §5.3).
//
// Ownership: this module owns the file/state primitives that `src/vault.js` used to own; the
// bodies are a faithful move — same call order, same error prose, same on-disk format
// (temp+rename, `.bak` snapshots, trash `<timestamp>/<rel>`). Ownership only, never behavior
// (brief §1.1 "等价搬迁"). Constraints honoured on purpose:
//   * no ambient root: every path decision derives from the injected `root` / `dataPaths`,
//     never from the global VAULT / HISTORY_PATH / TRASH_PATH / RETRIEVAL_INDEX_PATH bindings
//     (contract §43-5); only root-free policy is imported from config.js;
//   * no ambient lock: `mutationTail` is closure-local, so two runtimes serialize
//     independently and mutate in parallel (contract §10.2, MV-I01 / MV-I02, SEC-MV07);
//   * `deps.requireRequestAuthor` has no silent default: a runtime without an injected author
//     provider refuses writes instead of bypassing the existing guard (§5.3 / §10.1).
//
// Formatting is denser than the rest of `src/` on purpose: `scripts/check-architecture.mjs` caps
// new modules at 500 lines and a 3rd `vault-runtime/*` file is outside this lane's owner set.
import { constants as fsConstants, createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  EXCLUDED_DIRS,
  MAX_LIST_ENTRIES,
  MAX_READ_BYTES,
  MAX_VERSIONS_PER_FILE,
  OBSIDIAN_ACCEPTED_EXTENSIONS,
  READ_ONLY,
  TEXT_FILE_EXTENSIONS,
  VERSION_HISTORY_ENABLED,
} from "../config.js";

// --- Root-free helpers (re-exported through the `src/vault.js` compatibility facade) ----
export function assertWritable() {
  if (READ_ONLY) throw new Error("Server is read-only because OBSIDIAN_READ_ONLY=true");
}
export function normalizeVaultInput(userPath = "") {
  const raw = String(userPath).replaceAll("\\", "/").replace(/\0/g, "").trim();
  // A Windows drive (`D:\x`, `D:/x`, even drive-relative `D:x`) or a UNC share
  // (`\\server\share` -> `//server/share`) is never a vault-relative path. Treating one as
  // relative created a literal `D:` directory *inside* the vault (issue #218); Windows
  // clients then could never pull it (`name is invalid, contains Windows reserved
  // character: ":"`), so Syncthing showed a permanently failing folder. Fail closed.
  // Ordering matters: this guard sits AFTER the backslash unification above (so a UNC
  // `\\server\share` is already `//server/share` here) and BEFORE the leading-slash strip
  // below (which would otherwise turn `D:/x` into a relative path).
  // Note: the leading-slash semantics below are pinned by
  // `test/vault-runtime-local-fs.test.js` and deliberately unchanged.
  // Trade-off (evaluated, kept as is): a root-level name like `a:b.md` is rejected too.
  // The narrower rule ("drive must be followed by a separator or end-of-string") would only
  // admit names Windows can never sync anyway, so it buys nothing for an extra branch.
  if (/^[A-Za-z]:/.test(raw) || /^\/\/[^/]/.test(raw)) {
    throw new Error(`Vault paths are vault-relative; Windows absolute and UNC paths are not accepted: "${userPath}"`);
  }
  const normalized = path.posix.normalize(raw.replace(/^\/+/, ""));
  return normalized === "." ? "" : normalized;
}
export function hasExtension(userPath) {
  return path.posix.extname(userPath) !== "";
}
export function hasNumericExtension(userPath) {
  return /^\.\d+$/.test(path.posix.extname(userPath));
}
export function fileExtension(absOrRelPath) {
  return path.extname(absOrRelPath).toLowerCase();
}
export function isAcceptedObsidianFile(absOrRelPath) {
  return OBSIDIAN_ACCEPTED_EXTENSIONS.has(fileExtension(absOrRelPath));
}
export function isTextFile(absOrRelPath) {
  return TEXT_FILE_EXTENSIONS.has(fileExtension(absOrRelPath));
}
export function stripMarkdownExtension(notePath) {
  return notePath.replace(/\.md$/i, "");
}
export function decodeLinkTarget(target) {
  try { return decodeURIComponent(target); } catch { return target; }
}
export async function exists(absPath) {
  try { await fs.access(absPath); return true; } catch { return false; }
}
export async function ensureParent(absPath) {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
}
function assertInsideRoot(root, candidate, message = "Path traversal denied") {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(message);
}
// Generic canonical containment primitive; root-parameterized, so callers that guard a
// foreign root (history, trash, a secondary vault) use it directly — unchanged from the
// `src/vault.js` export this lane moved.
export async function assertCanonicalInsideRoot(root, absPath, options = {}) {
  assertInsideRoot(path.resolve(root), path.resolve(absPath));
  const canonicalRoot = await fs.realpath(root);
  let probe = absPath;

  while (true) {
    try {
      const canonicalProbe = await fs.realpath(probe);
      assertInsideRoot(canonicalRoot, canonicalProbe, "Symbolic link escapes the vault");
      return canonicalProbe;
    } catch (error) {
      if (error?.code !== "ENOENT" || !options.allowMissing) throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      probe = parent;
    }
  }
}
function describe(value) {
  return typeof value === "string" ? JSON.stringify(value) : value === null ? "null" : `${typeof value} ${String(value)}`;
}
function requirePath(value, label) {
  if (typeof value !== "string" || value === "") throw new Error(`vault-runtime/local-fs: ${label} must be a non-empty path string, got ${describe(value)}`);
  if (value.includes("\0")) throw new Error(`vault-runtime/local-fs: ${label} must not contain a NUL byte`);
  return value;
}

/**
 * `createLocalFs({ root, dataPaths, dataRoot = dataPaths.root ?? null, deps = {} })`.
 * `root` is the Vault content root (absolute); `dataPaths` is the A7 `vaultDataPaths(...)`
 * mapping (only `history` + `trash` are consumed here — retrieval / transfers / journal
 * belong to lanes B2 / B3 / B5 / B6); `dataRoot` is this Vault's protected data root
 * (primary: legacy DATA_PATH, secondary: the A7 `paths.root`; `getVaultHealth` only);
 * `deps` is `{ requireRequestAuthor, trackGitMutation }` with `requireRequestAuthor`
 * fail-closed when absent and `trackGitMutation` defaulting to a no-op (lane B4 owns
 * per-Vault Git, contract §16.4).
 *
 * Returns a frozen instance. Every method is a closure (never `this`), so callers may detach
 * them. All mutable state — the mutation lock — lives in this closure (§5.3 / SEC-MV07).
 */
export function createLocalFs(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error(`vault-runtime/local-fs: createLocalFs expects an input object, got ${describe(input)}`);
  if (!path.isAbsolute(requirePath(input.root, "root"))) throw new Error(`vault-runtime/local-fs: root must be absolute, got ${describe(input.root)}`);
  const root = path.resolve(input.root);
  const dataPaths = input.dataPaths;
  if (dataPaths === null || typeof dataPaths !== "object" || Array.isArray(dataPaths)) throw new Error(`vault-runtime/local-fs: dataPaths must be the A7 vaultDataPaths mapping, got ${describe(dataPaths)}`);
  const historyRoot = path.resolve(requirePath(dataPaths.history, "dataPaths.history"));
  const trashRoot = path.resolve(requirePath(dataPaths.trash, "dataPaths.trash"));
  const dataRoot = input.dataRoot === undefined || input.dataRoot === null ? null : path.resolve(requirePath(input.dataRoot, "dataRoot"));
  const deps = input.deps === null || typeof input.deps !== "object" ? {} : (input.deps ?? {});
  const requireRequestAuthor = deps.requireRequestAuthor === undefined
    ? () => { throw new Error("vault-runtime/local-fs: refusing to write without deps.requireRequestAuthor (no silent author-guard bypass)"); }
    : deps.requireRequestAuthor;
  if (typeof requireRequestAuthor !== "function") throw new Error("vault-runtime/local-fs: deps.requireRequestAuthor must be a function");
  const trackGitMutation = deps.trackGitMutation === undefined ? () => {} : deps.trackGitMutation;
  if (typeof trackGitMutation !== "function") throw new Error("vault-runtime/local-fs: deps.trackGitMutation must be a function");

  function assertInsideVault(absPath) {
    assertInsideRoot(root, absPath);
  }
  async function assertCanonicalInsideVault(absPath, options = {}) {
    assertInsideVault(absPath);
    return assertCanonicalInsideRoot(root, absPath, options);
  }
  async function openCanonicalVaultFile(absPath) {
    const canonicalPath = await assertCanonicalInsideVault(absPath), handle = await fs.open(canonicalPath, "r");
    try {
      const opened = await handle.stat({ bigint: true }), current = await fs.stat(await assertCanonicalInsideVault(canonicalPath), { bigint: true });
      if (opened.dev !== current.dev || opened.ino !== current.ino) throw new Error("Vault path changed during secure open"); return handle;
    } catch (error) { await handle.close().catch(() => {}); throw error; }
  }
  function assertNotVaultRoot(absPath) {
    if (path.resolve(absPath) === root) throw new Error("Refusing to modify or delete the vault root");
  }

  function resolveVaultPath(userPath = "", options = {}) {
    let normalized = normalizeVaultInput(userPath);
    if (options.assumeMarkdown && normalized && !/\.md$/i.test(normalized)) normalized = `${normalized}.md`;
    const resolved = path.resolve(root, normalized);
    assertInsideVault(resolved);
    return resolved;
  }

  function resolveCanvasPath(userPath) {
    let normalized = normalizeVaultInput(userPath);
    if (normalized && !hasExtension(normalized)) normalized = `${normalized}.canvas`;
    const resolved = path.resolve(root, normalized);
    assertInsideVault(resolved);
    return resolved;
  }

  function toVaultPath(absPath) {
    return path.relative(root, absPath).split(path.sep).join("/");
  }
  function normalizeNotePath(userPath) {
    return toVaultPath(resolveVaultPath(userPath, { assumeMarkdown: true }));
  }

  function resolveTrashPath(userPath = "") {
    const resolved = path.resolve(trashRoot, normalizeVaultInput(userPath));
    assertInsideRoot(trashRoot, resolved, "Trash path traversal denied");
    return resolved;
  }

  function toTrashPath(absPath) {
    return path.relative(trashRoot, absPath).split(path.sep).join("/");
  }
  async function ensureVaultParent(absPath) {
    await assertCanonicalInsideVault(absPath, { allowMissing: true });
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await assertCanonicalInsideVault(path.dirname(absPath));
  }

  async function fileRevision(absPath) {
    await assertCanonicalInsideVault(absPath);
    const hash = createHash("sha256");
    await new Promise((resolve, reject) => {
      const stream = createReadStream(absPath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", resolve);
    });
    return `sha256:${hash.digest("hex")}`;
  }
  async function assertRevision(absPath, ifMatch) {
    if (!ifMatch) return;
    const current = await fileRevision(absPath);
    if (current !== ifMatch) throw new Error(`Revision conflict: expected ${ifMatch}, current ${current}`);
  }

  // Per-runtime mutation lock (§10.2): closure-local promise chain. Same-Vault callbacks stay
  // strictly serial (MV-I01); two runtimes never share this tail (MV-I02).
  let mutationTail = Promise.resolve();

  async function withMutationLock(callback) {
    const previous = mutationTail;
    let release;
    mutationTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }

  async function atomicWriteFileUnlocked(absPath, data, options = {}) {
    assertWritable();
    requireRequestAuthor();
    await ensureVaultParent(absPath);
    const existed = await exists(absPath), preWrite = { versionId: null };
    if (existed) {
      await assertCanonicalInsideVault(absPath);
      await assertRevision(absPath, options.ifMatch);
      if (VERSION_HISTORY_ENABLED && !options.skipHistory) preWrite.versionId = await createVersionSnapshot(absPath);
    } else if (options.ifMatch) {
      throw new Error(`Revision conflict: expected ${options.ifMatch}, but the file does not exist`);
    }

    const tempPath = path.join(path.dirname(absPath), `.${path.basename(absPath)}.obsidian-mcp-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(tempPath, data, options.encoding);
      await fs.rename(tempPath, absPath);
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }

    const stat = await fs.stat(absPath);
    trackGitMutation(toVaultPath(absPath));
    return { stat, revision: await fileRevision(absPath), preWriteVersionId: preWrite.versionId };
  }

  async function atomicWriteFile(absPath, data, options = {}) {
    return withMutationLock(() => atomicWriteFileUnlocked(absPath, data, options));
  }

  async function createVersionSnapshot(absPath) {
    await assertCanonicalInsideVault(absPath);
    const rel = toVaultPath(absPath);
    const versionDirectory = path.join(historyRoot, ...rel.split("/"));
    await fs.mkdir(historyRoot, { recursive: true, mode: 0o700 });
    await assertCanonicalInsideRoot(historyRoot, versionDirectory, { allowMissing: true });
    await fs.mkdir(versionDirectory, { recursive: true });
    await assertCanonicalInsideRoot(historyRoot, versionDirectory);
    const versionName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.bak`;
    const versionAbs = path.join(versionDirectory, versionName);
    await fs.copyFile(absPath, versionAbs);
    const entries = (await fs.readdir(versionDirectory, { withFileTypes: true })).filter((entry) => entry.isFile()).sort((a, b) => b.name.localeCompare(a.name));
    for (const stale of entries.slice(Math.max(1, MAX_VERSIONS_PER_FILE))) await fs.unlink(path.join(versionDirectory, stale.name));
    return path.relative(historyRoot, versionAbs).split(path.sep).join("/");
  }

  async function listFileVersions(notePath, options = {}) {
    const abs = resolveVaultPath(notePath);
    const rel = toVaultPath(abs);
    const directory = path.join(historyRoot, ...rel.split("/"));
    if (!(await exists(directory))) return [];
    await assertCanonicalInsideRoot(historyRoot, directory);
    const entries = (await fs.readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".bak")).sort((a, b) => b.name.localeCompare(a.name));
    const versions = [];
    for (const entry of entries.slice(0, options.limit || MAX_VERSIONS_PER_FILE)) {
      const versionAbs = path.join(directory, entry.name);
      const stat = await fs.stat(versionAbs);
      versions.push({ versionId: path.relative(historyRoot, versionAbs).split(path.sep).join("/"), path: rel, created: stat.birthtime.toISOString(), modified: stat.mtime.toISOString(), size: stat.size });
    }
    return versions;
  }

  async function readFileVersion(versionId, { strictText = false } = {}) {
    const versionAbs = path.resolve(historyRoot, normalizeVaultInput(versionId));
    assertInsideRoot(historyRoot, versionAbs, "History path traversal denied");
    const canonicalVersion = await assertCanonicalInsideRoot(historyRoot, versionAbs);
    const stat = await fs.stat(canonicalVersion);
    if (!stat.isFile() || !versionAbs.endsWith(".bak")) throw new Error("Version ID must identify a .bak file");
    if (stat.size > MAX_READ_BYTES) throw new Error(`Version exceeds MAX_READ_BYTES (${stat.size} > ${MAX_READ_BYTES})`);
    const relativeVersion = path.relative(historyRoot, versionAbs).split(path.sep).join("/");
    const segments = relativeVersion.split("/");
    if (segments.length < 2) throw new Error("Invalid version ID");
    const bytes = await fs.readFile(canonicalVersion);
    const content = strictText ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) : bytes.toString("utf-8");
    return { versionId: relativeVersion, path: segments.slice(0, -1).join("/"), content, size: stat.size, created: stat.birthtime.toISOString(), modified: stat.mtime.toISOString() };
  }

  async function restoreFileVersion(versionId, options = {}) {
    assertWritable();
    const versionAbs = path.resolve(historyRoot, normalizeVaultInput(versionId));
    assertInsideRoot(historyRoot, versionAbs, "History path traversal denied");
    const canonicalVersion = await assertCanonicalInsideRoot(historyRoot, versionAbs);
    const relativeVersion = path.relative(historyRoot, versionAbs).split(path.sep).join("/");
    const segments = relativeVersion.split("/");
    if (segments.length < 2) throw new Error("Invalid version ID");
    const originalPath = segments.slice(0, -1).join("/");
    const destination = options.destination || originalPath;
    const destinationAbs = resolveVaultPath(destination);
    if ((await exists(destinationAbs)) && !options.overwrite) throw new Error("Restore destination exists. Set overwrite=true to replace it.");
    const written = await atomicWriteFile(destinationAbs, await fs.readFile(canonicalVersion), { ifMatch: options.ifMatch, skipHistory: false });
    return { versionId: relativeVersion, restoredPath: toVaultPath(destinationAbs), revision: written.revision, size: written.stat.size };
  }

  // Same bytes, same limits, same `openCanonicalVaultFile` confinement — the only difference is
  // that the caller gets the buffer instead of the decoded text. A caller that needs a CAS token
  // *and* the text must read through here once: `readLimitedText` decodes with replacement
  // (invalid sequences become U+FFFD), so a token derived from its result is a different quantity
  // from the one `fileRevision` (bytes) checks inside the write lock.
  async function readLimitedBuffer(absPath) {
    const handle = await openCanonicalVaultFile(absPath), limit = MAX_READ_BYTES + 1;
    try {
      const chunks = [], buffer = Buffer.allocUnsafe(Math.min(64 * 1024, limit));
      let total = 0;
      while (total < limit) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, limit - total), total);
        if (!bytesRead) break;
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead))); total += bytesRead;
      }
      if (total > MAX_READ_BYTES) throw new Error(`File exceeds MAX_READ_BYTES (${total} > ${MAX_READ_BYTES})`);
      return Buffer.concat(chunks, total);
    } finally { await handle.close(); }
  }

  async function readLimitedText(absPath) {
    return (await readLimitedBuffer(absPath)).toString("utf8");
  }

  async function walk(startAbs, options = {}) {
    const { recursive = true, depth = 20, includeDirectories = false, includeHidden = false, extension = ".md", nameRegex, afterPath, entryFilter, maxEntries = MAX_LIST_ENTRIES } = options;
    const entries = [];
    const matcher = nameRegex ? new RegExp(nameRegex, "i") : null;
    const wantedExtension = extension === "*" ? "*" : String(extension || ".md").toLowerCase();
    await assertCanonicalInsideVault(startAbs);

    async function visit(currentAbs, currentDepth) {
      const dirents = (await fs.readdir(currentAbs, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const dirent of dirents) {
        if (entries.length >= maxEntries) return;
        if (!includeHidden && dirent.name.startsWith(".")) continue;
        if (dirent.isSymbolicLink()) continue;
        if (dirent.isDirectory() && EXCLUDED_DIRS.has(dirent.name)) continue;

        const abs = path.join(currentAbs, dirent.name);
        const rel = toVaultPath(abs);
        if (dirent.isDirectory()) {
          const entry = { path: rel, name: dirent.name, type: "directory" };
          if (includeDirectories && (!matcher || matcher.test(dirent.name)) && (!afterPath || rel > afterPath) && (!entryFilter || entryFilter(entry))) entries.push(entry);
          if (recursive && currentDepth < depth) await visit(abs, currentDepth + 1);
          continue;
        }

        const ext = fileExtension(dirent.name);
        if (wantedExtension !== "*" && ext !== wantedExtension) continue;
        if (matcher && !matcher.test(dirent.name) && !matcher.test(rel)) continue;
        const stat = await fs.stat(abs);
        const entry = { path: rel, name: dirent.name, type: "file", extension: ext, size: stat.size, modified: stat.mtime.toISOString() };
        if ((!afterPath || rel > afterPath) && (!entryFilter || entryFilter(entry))) entries.push(entry);
      }
    }

    await visit(startAbs, 0);
    return entries;
  }

  async function allMarkdownFiles(options = {}) {
    const prefix = options.pathPrefix ? normalizeVaultInput(options.pathPrefix) : "";
    const start = prefix ? resolveVaultPath(prefix) : root;
    const stat = await fs.stat(start);
    if (stat.isFile()) return [start];
    const walkOptions = { recursive: true, includeDirectories: false, includeHidden: options.includeHidden || false, extension: ".md", maxEntries: options.maxEntries || Number.MAX_SAFE_INTEGER };
    const entries = await walk(start, walkOptions);
    return entries.map((entry) => resolveVaultPath(entry.path));
  }
  async function backupBeforeDelete(absPath) {
    await assertCanonicalInsideVault(absPath);
    const rel = toVaultPath(absPath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(trashRoot, timestamp, rel);
    await ensureParent(backupPath);
    await fs.copyFile(absPath, backupPath);
    return backupPath;
  }

  async function listTrashEntries(options = {}) {
    await fs.mkdir(trashRoot, { recursive: true });
    const prefix = options.pathPrefix ? normalizeVaultInput(options.pathPrefix) : "";
    const start = resolveTrashPath(prefix);
    if (!(await exists(start))) return [];
    await assertCanonicalInsideRoot(trashRoot, start);
    const entries = [];
    const record = (abs, stat) => ({ backupPath: toTrashPath(abs), originalPath: toTrashPath(abs).split("/").slice(1).join("/"), size: stat.size, modified: stat.mtime.toISOString() });

    async function visit(current) {
      for (const dirent of await fs.readdir(current, { withFileTypes: true })) {
        if (entries.length >= (options.limit || MAX_LIST_ENTRIES)) return;
        if (dirent.isSymbolicLink()) continue;
        const abs = path.join(current, dirent.name);
        if (dirent.isDirectory()) { await visit(abs); continue; }
        entries.push(record(abs, await fs.stat(abs)));
      }
    }

    const stat = await fs.stat(start);
    if (stat.isFile()) return [record(start, await fs.stat(start))];
    await visit(start);
    return entries;
  }

  async function readTrashEntry(backupPath, { strictText = false, maxBytes = MAX_READ_BYTES } = {}) {
    const backupAbs = resolveTrashPath(backupPath);
    await assertCanonicalInsideRoot(trashRoot, backupAbs);
    const stat = await fs.lstat(backupAbs);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Trash entry must be a regular file");
    if (stat.size > maxBytes) throw new Error(`Trash entry exceeds read limit (${stat.size} > ${maxBytes})`);
    const relativeBackup = toTrashPath(backupAbs);
    const bytes = await fs.readFile(backupAbs);
    const content = strictText ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) : bytes.toString("utf-8");
    return { backupPath: relativeBackup, originalPath: relativeBackup.split("/").slice(1).join("/"), content, revision: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, size: bytes.length };
  }

  async function restoreTrashEntry(backupPath, options = {}) {
    assertWritable();
    const backupAbs = resolveTrashPath(backupPath);
    await assertCanonicalInsideRoot(trashRoot, backupAbs);
    const relativeBackup = toTrashPath(backupAbs);
    const inferredOriginal = relativeBackup.split("/").slice(1).join("/");
    const destination = options.destination || inferredOriginal;
    if (!destination) throw new Error("Unable to infer the original vault path; provide destination");
    const destinationAbs = resolveVaultPath(destination);
    if ((await exists(destinationAbs)) && !options.overwrite) throw new Error("Restore destination exists. Set overwrite=true to replace it.");
    const written = await atomicWriteFile(destinationAbs, await fs.readFile(backupAbs));
    if (options.removeBackup) await fs.unlink(backupAbs);
    return { backupPath: relativeBackup, restoredPath: toVaultPath(destinationAbs), revision: written.revision, size: written.stat.size, backupRemoved: Boolean(options.removeBackup) };
  }

  async function removeEmptyParents(startDirectory, rootOfTree) {
    let current = startDirectory;
    while (path.resolve(current) !== path.resolve(rootOfTree)) {
      try {
        await fs.rmdir(current);
      } catch (error) {
        if (error?.code === "ENOTEMPTY" || error?.code === "ENOENT") return;
        throw error;
      }
      current = path.dirname(current);
    }
  }

  async function deleteTrashEntry(backupPath) {
    assertWritable();
    const backupAbs = resolveTrashPath(backupPath);
    await assertCanonicalInsideRoot(trashRoot, backupAbs);
    const stat = await fs.stat(backupAbs);
    if (!stat.isFile()) throw new Error("Trash entry must be a file");
    await fs.unlink(backupAbs);
    await removeEmptyParents(path.dirname(backupAbs), trashRoot);
    return { deletedBackup: toTrashPath(backupAbs) };
  }

  async function deleteFileVersion(versionId) {
    assertWritable();
    const versionAbs = path.resolve(historyRoot, normalizeVaultInput(versionId));
    assertInsideRoot(historyRoot, versionAbs, "History path traversal denied");
    await assertCanonicalInsideRoot(historyRoot, versionAbs);
    const stat = await fs.stat(versionAbs);
    if (!stat.isFile() || !versionAbs.endsWith(".bak")) throw new Error("Version ID must identify a .bak file");
    const relativeVersion = path.relative(historyRoot, versionAbs).split(path.sep).join("/");
    await fs.unlink(versionAbs);
    await removeEmptyParents(path.dirname(versionAbs), historyRoot);
    return { deletedVersion: relativeVersion };
  }
  async function getVaultHealth() {
    try {
      await fs.mkdir(root, { recursive: true });
      await fs.access(root, fsConstants.R_OK);
      if (!READ_ONLY && dataRoot) {
        await fs.mkdir(dataRoot, { recursive: true });
        await fs.access(root, fsConstants.W_OK);
        await fs.access(dataRoot, fsConstants.W_OK);
      }
      return { ok: true, vaultPath: root, dataPath: dataRoot, trashPath: trashRoot, historyPath: historyRoot, versionHistoryEnabled: VERSION_HISTORY_ENABLED, maxVersionsPerFile: MAX_VERSIONS_PER_FILE, readOnly: READ_ONLY, maxReadBytes: MAX_READ_BYTES };
    } catch (error) {
      return { ok: false, vaultPath: root, dataPath: dataRoot, trashPath: trashRoot, readOnly: READ_ONLY, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // Frozen machine seam (contract §10 / §5.1): every entry is a closure with a fixed arity.
  return Object.freeze({
    root, dataRoot, dataPaths, historyRoot, trashRoot,
    assertInsideVault, assertCanonicalInsideVault, openCanonicalVaultFile, assertNotVaultRoot,
    resolveVaultPath, resolveCanvasPath, toVaultPath, normalizeNotePath,
    resolveTrashPath, toTrashPath, ensureVaultParent,
    fileRevision, assertRevision, withMutationLock, atomicWriteFile,
    createVersionSnapshot, listFileVersions, readFileVersion, restoreFileVersion,
    readLimitedText, readLimitedBuffer, walk, allMarkdownFiles,
    backupBeforeDelete, listTrashEntries, readTrashEntry, restoreTrashEntry,
    deleteTrashEntry, deleteFileVersion, getVaultHealth,
  });
}
