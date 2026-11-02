// Test preload: never hand a `fetch`-unusable port to a fixture.
//
// This machine's TCP dynamic port range is `1024 + 13977` (`netsh int ipv4 show dynamicport tcp`),
// not the Windows default `49152 + 16384`, so every fixture that calls `server.listen(0)` draws from
// a range that overlaps undici's hard-coded "bad port" blocklist (6665–6669, 5060, 6000, 10080 …).
// When a draw lands on one of those, the *test's* `fetch` fails with
// `TypeError: fetch failed` / `cause: Error: bad port` and a check that has nothing to do with the
// candidate goes red. Observed on `audit-attribution-source`, `discovery-runtime`,
// `authorization-transfer-admin-e2e`, `web-base-*` across full serial runs of 2026-10-19.
//
// This preload re-listens on a fresh ephemeral port when the OS hands out a blocked one. It touches no
// source file, no test file and no assertion — only which free port a *fixture* binds. It is the
// in-tree form of the shim the local receipt used (`scratch/admin-parity/evidence-run-shim.cjs`,
// which documents the same finding), so the documented serial command is deterministic without a
// scratch-file workaround:
//
//   node --import ./test/preload-fetch-safe-listen.mjs --test --test-concurrency=1 …
//
// `test/fetch-safe-port.mjs` is the direct fix for a test that is edited anyway; this preload covers
// the ~40 files that still say `listen(0)`.
import net from "node:net";

// undici's `badPorts` set (node:internal/deps/undici/undici).
const BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103,
  104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513,
  514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

const originalListen = net.Server.prototype.listen;

const requestsEphemeralPort = (args) => {
  const first = args[0];
  if (typeof first === "number") return first === 0;
  if (first && typeof first === "object" && !Array.isArray(first)) return (first.port ?? 0) === 0;
  return !first || typeof first === "function"; // listen() / listen(cb) → port 0
};

net.Server.prototype.listen = function listenWithoutBlockedPorts(...args) {
  if (!requestsEphemeralPort(args)) return originalListen.apply(this, args);
  const callbackIndex = args.findIndex((argument) => typeof argument === "function");
  const userCallback = callbackIndex >= 0 ? args[callbackIndex] : null;
  let attempts = 0;
  const attempt = () => {
    const callback = () => {
      let port = -1;
      try { port = this.address()?.port ?? -1; } catch { port = -1; }
      if (BLOCKED_PORTS.has(port) && attempts < 40) {
        attempts += 1;
        this.close(() => attempt());
        return;
      }
      if (userCallback) userCallback.call(this);
    };
    const callArgs = userCallback === null
      ? [...args, callback]
      : args.map((argument, index) => (index === callbackIndex ? callback : argument));
    originalListen.apply(this, callArgs);
  };
  attempt();
  return this;
};

if (process.env.FETCH_SAFE_LISTEN_MARK !== "0") {
  process.stderr.write("[preload-fetch-safe-listen] net.Server#listen(0) skips undici-blocked ports\n");
}
