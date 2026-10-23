// A bound port that Node's global `fetch` will actually talk to.
//
// Why this exists. `server.listen(0, "127.0.0.1")` hands the choice of port to the OS, and Node's
// `fetch` (undici) refuses a fixed list of ports outright — it throws `TypeError: fetch failed` with
// `cause: Error: bad port` before the request is even attempted. On this machine the ephemeral range
// includes that list, so a run can hand out e.g. 6667 and every `fetch` to the freshly bound server
// fails, which looks like a server/socket bug and is not: the same test passes as soon as the OS picks
// another port. Found while running the serial full suite for Wave Q (4 red tests, one cause).
//
// Use `fetchSafePort()` instead of a literal `0` whenever the port is about to be used by `fetch`:
//
//   const server = app.listen(await fetchSafePort(), "127.0.0.1");
//
// (Tests that drive `node:http` with an extra `request()`/`http.request` and never `fetch` are not
// affected and can keep `listen(0)`.)
import net from "node:net";

/** True when `fetch` refuses the port for being on undici's blocked-port list. */
function isBlockedPortError(error) {
  const messages = [error?.cause?.message, error?.message, String(error)];
  return messages.some((message) => /bad port/i.test(String(message ?? "")));
}

/**
 * True when the port is usable through `fetch`. A closed port is fine (the connection is refused,
 * which is not a blocked-port error); only the blocked-port refusal counts.
 */
export async function isFetchSafePort(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`);
    return true;
  } catch (error) {
    return !isBlockedPortError(error);
  }
}

/** Allocate an ephemeral port the OS handed out AND `fetch` accepts. */
export async function fetchSafePort() {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const { port: assigned } = probe.address();
        probe.close((error) => (error ? reject(error) : resolve(assigned)));
      });
    });
    if (await isFetchSafePort(port)) return port;
  }
  throw new Error("no fetch-safe ephemeral port could be allocated (every candidate was on undici's blocked-port list)");
}
