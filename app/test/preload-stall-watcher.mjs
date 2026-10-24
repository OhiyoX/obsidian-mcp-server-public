// Test-only `--import` preload. It makes the real chokidar FSWatcher.close()
// deterministic (reject or never settle) so the server shutdown deadline and
// cleanup-failure reporting can be exercised end-to-end in a child process.
// It is only activated when WEB_TEST_WATCHER_CLOSE is set.
import chokidar from "chokidar";

const mode = process.env.WEB_TEST_WATCHER_CLOSE;
if (mode && chokidar?.FSWatcher?.prototype) {
  chokidar.FSWatcher.prototype.close = mode === "hang"
    ? function close() { return new Promise(() => {}); }
    : function close() { return Promise.reject(new Error("synthetic watcher close failure")); };
}
