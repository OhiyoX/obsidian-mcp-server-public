// One implementation of "listen on a loopback port `fetch()` will accept".
//
// WHY: WHATWG fetch (Node's undici, i.e. every `fetch()` in this repository)
// refuses a fixed list of "bad ports" *before* attempting the request. On hosts
// whose dynamic port range starts low — Windows allocates 1024-15000 — an
// OS-assigned `listen(0)` port can land in that list, and the harness then fails
// with `TypeError: fetch failed … bad port`. That is a host-level flake, not a
// code defect (issue #344), so every listener that a test subsequently fetches
// has to go through here instead of hand-rolling its own guard.
//
// Strategy (merges the two fixes that already existed before this module):
// prefer an explicit candidate above the top of the bad-port list, keep `listen(0)`
// as the fallback for hosts that cannot bind high ports, and retry a bounded
// number of times, closing the socket between attempts.

/**
 * The WHATWG fetch "bad port" list. Kept complete (rather than trimmed to the
 * ports we have seen) so a future spec addition below the candidate floor still
 * cannot slip through the `listen(0)` fallback.
 */
export const FETCH_BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 419, 420,
  427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989,
  990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666,
  6667, 6668, 6669, 6679, 6697, 10080,
]);

/** Every bad port is <= this, so a candidate above it is fetch-safe by construction. */
export const FETCH_BAD_PORT_MAX = Math.max(...FETCH_BAD_PORTS);

/**
 * True when `fetch()` would refuse `port` before dialing it. Anything at or below
 * {@link FETCH_BAD_PORT_MAX} counts, because a host that allocates from a low
 * dynamic range can return a bad port we did not enumerate.
 */
export function isFetchUnsafePort(port) {
  return !Number.isInteger(port) || port <= FETCH_BAD_PORT_MAX || FETCH_BAD_PORTS.has(port);
}

function randomFetchSafeCandidate() {
  const min = FETCH_BAD_PORT_MAX + 1;
  return min + Math.floor(Math.random() * (65535 - min + 1));
}

async function tryListen(target, port, host) {
  try {
    return await new Promise((resolve, reject) => {
      const onError = (error) => {
        target.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        target.off("error", onError);
        resolve(target.address());
      };
      target.once("error", onError);
      target.once("listening", onListening);
      target.listen(port, host);
    });
  } catch {
    return null;
  }
}

async function closeTarget(target) {
  await new Promise((resolve) => target.close(() => resolve()));
}

/**
 * Listen on a fetch-safe loopback port and return the bound port.
 *
 * `target` is anything with `listen(port, host)`, `address()` and `close()` — an
 * `http.Server` or the server returned by `app.listen(...)`. The caller keeps
 * ownership of the socket and must still close it (e.g. in `t.after`); this
 * helper only re-listens *it* while searching, closing it between attempts.
 *
 * @param {{listen: Function, address: Function, close: Function}} target
 * @param {{host?: string, maxAttempts?: number, candidates?: number[] | ((attempt: number) => number)}} [options]
 *   `candidates` (test/telemetry only) pins the exact port to try per attempt — an
 *   array (consumed in order) or a function of the attempt index. With it pinned there
 *   is **no** `listen(0)` fallback, so a test can drive the bad-port retry path
 *   deterministically instead of hoping the OS hands one out.
 * @returns {Promise<number>} the bound port
 */
export async function listenFetchSafe(target, { host = "127.0.0.1", maxAttempts = 16, candidates = null } = {}) {
  const pin = typeof candidates === "function" ? candidates : Array.isArray(candidates) ? (_attempt) => candidates[_attempt] : null;
  const attempts = maxAttempts;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const pinnedPort = pin?.(attempt);
    const address = pinnedPort === undefined || pinnedPort === null
      ? (await tryListen(target, randomFetchSafeCandidate(), host)) ?? (await tryListen(target, 0, host))
      : await tryListen(target, pinnedPort, host);
    if (address && typeof address === "object" && !isFetchUnsafePort(address.port)) return address.port;
    await closeTarget(target);
  }
  throw new Error(`Could not allocate a fetch-safe loopback port after ${attempts} attempts (issue #344)`);
}

/** Same as {@link listenFetchSafe}, but returns `http://host:port`. */
export async function listenFetchSafeOrigin(target, options = {}) {
  const { host = "127.0.0.1", ...rest } = options;
  return `http://${host}:${await listenFetchSafe(target, { host, ...rest })}`;
}
