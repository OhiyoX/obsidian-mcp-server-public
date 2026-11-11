// Task 1 — the real io seam for `createAuthorizationStore`.
//
// The store takes an explicit `io` so a test can make rename or sync fail without a real
// disk fault (design §9). This is the production implementation: one name per
// `fs/promises` call the store makes. `open` returns the file handle itself, because the
// store calls `writeFile`, `sync` and `close` on it.
//
// `fsPromises` is injectable so a caller can wrap the same shape without a second copy.

import * as fsPromises from "node:fs/promises";

export function createNodeAuthorizationIo({ fsPromises: fs = fsPromises } = {}) {
  return Object.freeze({
    mkdir: (target, options) => fs.mkdir(target, options),
    readFile: (target) => fs.readFile(target),
    open: (target, flags, mode) => fs.open(target, flags, mode),
    rename: (from, to) => fs.rename(from, to),
    unlink: (target) => fs.unlink(target),
    chmod: (target, mode) => fs.chmod(target, mode),
  });
}
