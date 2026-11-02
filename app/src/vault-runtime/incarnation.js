// R-B: persistent directory lifecycle proof. Reads never create/repair a marker.
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const INCARNATION_FILE = ".obsidian-mcp-incarnation.json";
export const INCARNATION_UNRESOLVED = "VAULT_INCARNATION_UNRESOLVED";
const MAX_BYTES = 256;
function fail(error) {
  throw Object.assign(new Error(`directory incarnation proof unavailable (${error?.code ?? "invalid marker"})`),
    { code: INCARNATION_UNRESOLVED, missing: error?.code === "ENOENT" });
}
function parse(bytes) {
  const value = JSON.parse(bytes);
  if (value?.version !== 1 || !/^[0-9a-f]{64}$/.test(value.incarnation) || Object.keys(value).sort().join(",") !== "incarnation,version") fail();
  return value.incarnation;
}
export async function readIncarnation(root, fsApi = fs) {
  let handle;
  try {
    const file = path.join(root, INCARNATION_FILE);
    const stat = await fsApi.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) fail();
    handle = await fsApi.open(file, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_BYTES || opened.dev !== stat.dev || opened.ino !== stat.ino) fail();
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_BYTES) fail();
    return parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } catch (error) { fail(error); } finally { await handle?.close(); }
}
export function readIncarnationSync(root) {
  let fd;
  try {
    const file = path.join(root, INCARNATION_FILE);
    const stat = fsSync.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) fail();
    fd = fsSync.openSync(file, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0));
    const opened = fsSync.fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_BYTES || opened.dev !== stat.dev || opened.ino !== stat.ino) fail();
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    const count = fsSync.readSync(fd, bytes, 0, bytes.length, 0);
    if (count > MAX_BYTES) fail();
    return parse(bytes.subarray(0, count).toString("utf8"));
  } catch (error) { fail(error); } finally { if (fd !== undefined) fsSync.closeSync(fd); }
}

// Only the explicit administrator enrollment path calls this. Never overwrite an existing proof.
export async function initializeIncarnation(root, fsApi = fs) {
  try { return await readIncarnation(root, fsApi); } catch (error) {
    // Distinguish genuine absence from corrupt/unreadable proof; never repair the latter.
    try { await fsApi.lstat(path.join(root, INCARNATION_FILE)); } catch (missing) {
      if (missing.code !== "ENOENT") throw error;
      const incarnation = randomBytes(32).toString("hex");
      try {
        await fsApi.writeFile(path.join(root, INCARNATION_FILE), `${JSON.stringify({ version: 1, incarnation })}\n`, { flag: "wx", mode: 0o600 });
      } catch (writeError) { if (writeError.code !== "EEXIST") fail(writeError); }
      return readIncarnation(root, fsApi);
    }
    throw error;
  }
}
