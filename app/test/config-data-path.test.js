import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { defaultDataPath } from "../src/config.js";

// The default must never resolve to a drive root on Windows. `path.resolve("/data")` does exactly that
// (`<cwd drive>:\data`), which is how a local `npm test` run from `D:\` used to leave a stray `D:\data`.
// The helper is pure so this rule is verifiable on every platform.
test("data path default: /data on POSIX, <app>/data on win32", () => {
  assert.equal(defaultDataPath("linux", "/srv/repo/app"), "/data");
  assert.equal(defaultDataPath("darwin", "/srv/repo/app"), "/data");

  const appDir = path.join(path.sep, "srv", "repo", "app");
  const win = defaultDataPath("win32", appDir);
  assert.equal(win, path.join(appDir, "data"), "win32 default lives under the app directory");
  assert.equal(win.startsWith(appDir + path.sep), true, "win32 default is inside the app directory");
  assert.notEqual(win, path.resolve("/data"), "win32 default must not be the drive root");
  assert.equal(path.dirname(win), appDir, "win32 default has no cwd dependence");
});

test("data path default: an explicit app dir is honoured verbatim", () => {
  const appDir = path.join(path.sep, "opt", "obsidian", "app");
  assert.equal(defaultDataPath("win32", appDir), path.join(appDir, "data"));
});
