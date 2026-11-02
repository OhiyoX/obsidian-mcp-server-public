// Hard-bounded file reads for context-style callers.
//
// `stat.size` alone is not a safe ceiling: a file can grow between the stat
// and the read. `readFileWithinCap` therefore opens a file handle, fstats it
// before and after the read, and reads through the handle, stopping after
// `capBytes + 1` bytes. When the returned `tooLarge` flag is false and
// `changed` is false the returned buffer is the file content read from that
// handle and no metadata mutation was observed, so it may be hashed as a
// revision. When `tooLarge` is true only a bounded prefix was read; when
// `changed` is true the handle metadata changed during the read. In either
// case callers must not claim a full-content revision. The returned `stat` is
// the handle-level fstat snapshot and is the authority for metadata, not an
// earlier path-level stat.
//
// The reader opens the canonical in-Vault target through the shared verified
// handle primitive. This closes the check-then-open symlink swap window: the
// path resolved by canonical validation is the one opened, and the opened file
// identity is rechecked before any content is read. A genuinely missing target
// still surfaces as ENOENT so callers can map it to their own not-found result.

import { createHash } from "node:crypto";
import { openCanonicalVaultFile } from "./vault.js";

const CHUNK_BYTES = 64 * 1024;

function mutationBetween(before, after) {
  if (!before || !after) return false;
  return before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino;
}

// Wave D / D-intelligence: `openCanonical` is an additive seam so a per-Vault caller can supply the
// *selected* Vault's canonical opener (`vaultRuntime.localFs.openCanonicalVaultFile`). The default
// keeps the legacy primary-bound primitive for every pre-existing caller.
export async function readFileWithinCap(absPath, capBytes, openCanonical = openCanonicalVaultFile) {
  const cap = Number.isFinite(capBytes) && capBytes > 0 ? Math.floor(capBytes) : 0;
  const hardLimit = cap + 1;
  const handle = await openCanonical(absPath);
  try {
    const before = await handle.stat();
    const chunks = [];
    let total = 0;
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, hardLimit));
    while (total < hardLimit) {
      const want = Math.min(buffer.length, hardLimit - total);
      const { bytesRead } = await handle.read(buffer, 0, want, total);
      if (!bytesRead) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      total += bytesRead;
    }
    const after = await handle.stat();
    return {
      tooLarge: total >= hardLimit,
      changed: mutationBetween(before, after),
      bytesRead: total,
      data: Buffer.concat(chunks, total),
      stat: after,
    };
  } finally {
    await handle.close();
  }
}

export function hashBuffer(data) {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}
