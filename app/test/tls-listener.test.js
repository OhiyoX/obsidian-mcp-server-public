// The optional TLS listener (docs/RELEASE_AND_DEPLOY.md -> "Encrypted upstream hop").
//
// The claim under test is about the wire, not about a config parse: a client that speaks TLS to this
// listener gets the same handler, and a half-configured pair never answers at all.
import assert from "node:assert/strict";
import https from "node:https";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTlsListener } from "../src/tls-listener.js";

const CERT_FILE = fileURLToPath(new URL("./fixtures/tls/server.crt", import.meta.url));
const KEY_FILE = fileURLToPath(new URL("./fixtures/tls/server.key.pem", import.meta.url));
const handler = (req, res) => res.end("ok");

function request(port) {
  return new Promise((resolve, reject) => {
    // The fixture certificate names 127.0.0.1; verification itself is covered by the edge's
    // proxy_ssl_verify, not here.
    const req = https.request({ host: "127.0.0.1", port, path: "/", rejectUnauthorized: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body, encrypted: req.socket.encrypted === true }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("no certificate configured means no second listener", () => {
  assert.equal(createTlsListener(handler), null);
});

test("half a certificate pair fails the boot instead of serving plaintext", () => {
  assert.throws(() => createTlsListener(handler, { certFile: CERT_FILE }), /must be set together/);
  assert.throws(() => createTlsListener(handler, { keyFile: KEY_FILE }), /must be set together/);
});

test("a configured pair serves the same handler over TLS", async () => {
  const server = createTlsListener(handler, { certFile: CERT_FILE, keyFile: KEY_FILE });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const answer = await request(server.address().port);
    assert.deepEqual(answer, { status: 200, body: "ok", encrypted: true });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
