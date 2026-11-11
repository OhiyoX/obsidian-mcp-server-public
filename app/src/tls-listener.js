// Optional TLS listener for the plaintext application (see docs/RELEASE_AND_DEPLOY.md →
// "Encrypted upstream hop").
//
// The edge proxy keeps its own HTTP policy (paths, timeouts, body cap) and terminates the browser's
// TLS; this listener encrypts the **second** hop, from the proxy to this process, with a private CA.
// It reuses the same Express app, so every route, gate and header behaves exactly as on the
// plaintext port — the only difference is the transport.
//
// Off unless both files are configured. One file alone fails the boot: a server that answered
// plaintext because half its configuration was missing is the failure this module exists to prevent.
import fs from "node:fs";
import https from "node:https";

export function createTlsListener(app, { certFile = "", keyFile = "" } = {}) {
  if (!certFile && !keyFile) return null;
  if (!certFile || !keyFile) throw new Error("TLS_CERT_FILE and TLS_KEY_FILE must be set together");
  return https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, app);
}
