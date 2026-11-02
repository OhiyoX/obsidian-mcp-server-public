import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Bind before importing any production module that freezes config at module load.
// An explicit root belongs to the caller; otherwise this fixture owns a fresh root.
export const ownsW3DataPath = !process.env.DATA_PATH;
export const w3DataPath = ownsW3DataPath
  ? await fs.mkdtemp(path.join(os.tmpdir(), "vault-w3-data-"))
  : path.resolve(process.env.DATA_PATH);
assert.notEqual(w3DataPath, path.resolve("/data"), "product default data directory refused");
assert.notEqual(w3DataPath, path.parse(w3DataPath).root, "drive/filesystem root refused");
process.env.DATA_PATH = w3DataPath;

export function assertW3DataPath() {
  assert.ok(process.env.DATA_PATH, "known isolated DATA_PATH required");
  assert.equal(path.resolve(process.env.DATA_PATH), w3DataPath, "DATA_PATH must retain the known isolated binding");
}

export async function cleanupW3DataPath() {
  if (ownsW3DataPath) await fs.rm(w3DataPath, { recursive: true, force: true });
}

console.log("W3_DATA_PATH", JSON.stringify({ path: w3DataPath, owner: ownsW3DataPath ? "fixture" : "caller" }));
