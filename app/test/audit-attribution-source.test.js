// Issue #285 — Source attribution: final adopted IP vs direct peer vs Forwarded chain.
//
// Hard security boundary: `source` keeps its existing meaning (the address Express
// adopted with the configured trust-proxy predicate), so an untrusted direct peer
// that sends a forged `X-Forwarded-For` still cannot change it. The raw chain is
// recorded for diagnostics only.

import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import express from "express";
import { fetchSafePort } from "./fetch-safe-port.mjs";

import {
  FORWARDED_CHAIN_MAX_HOPS, boundedForwardedChain, isLoopbackAddress, normalizeAddress, requestSourceAttribution,
} from "../src/request-attribution.js";

function fakeRequest({ ip, peer, headers = {}, trust = false }) {
  return {
    ip,
    socket: { remoteAddress: peer },
    headers,
    app: { get: (key) => (key === "trust proxy" ? trust : undefined) },
  };
}

test("no Forwarded header keeps the direct peer as the adopted source", () => {
  const attributed = requestSourceAttribution(fakeRequest({ ip: "192.168.1.50", peer: "192.168.1.50" }));
  assert.equal(attributed.source, "192.168.1.50");
  assert.equal(attributed.sourcePeer, "192.168.1.50");
  assert.deepEqual(attributed.forwardedChain, []);
  assert.equal(attributed.sourceTrusted, false);
  assert.equal(attributed.sourceTrustedEntry, "none");
  assert.equal(attributed.sourceKind, "direct");
});

test("loopback is labelled as such instead of a bare 127.0.0.1", () => {
  for (const address of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(isLoopbackAddress(address), true, address);
    const attributed = requestSourceAttribution(fakeRequest({ ip: address, peer: address }));
    assert.equal(attributed.sourceKind, "loopback", address);
    assert.equal(attributed.source, address, "the original address text must be preserved verbatim");
  }
  assert.equal(isLoopbackAddress("192.168.1.1"), false);
  assert.equal(normalizeAddress("::ffff:192.168.1.100"), "192.168.1.100");
});

test("a trusted proxy hop adopts the forwarded client and records the entry", () => {
  const attributed = requestSourceAttribution(fakeRequest({
    ip: "203.0.113.5",
    peer: "127.0.0.1",
    headers: { "x-forwarded-for": "203.0.113.5" },
    trust: "127.0.0.1, 10.0.0.55",
  }));
  assert.equal(attributed.source, "203.0.113.5");
  assert.equal(attributed.sourcePeer, "127.0.0.1");
  assert.deepEqual(attributed.forwardedChain, ["203.0.113.5"]);
  assert.equal(attributed.sourceTrusted, true);
  assert.equal(attributed.sourceTrustedEntry, "127.0.0.1, 10.0.0.55");
  assert.equal(attributed.sourceKind, "trusted-proxy");
});

test("an untrusted peer cannot change the source by sending a forged chain", () => {
  const attributed = requestSourceAttribution(fakeRequest({
    ip: "192.168.1.50",
    peer: "192.168.1.50",
    headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
  }));
  assert.equal(attributed.source, "192.168.1.50", "the forged chain must never become source");
  assert.equal(attributed.sourcePeer, "192.168.1.50");
  assert.deepEqual(attributed.forwardedChain, ["1.2.3.4", "5.6.7.8"]);
  assert.equal(attributed.sourceTrusted, false);
  assert.equal(attributed.sourceTrustedEntry, "none");
  assert.equal(attributed.sourceKind, "untrusted-forwarded");
});

test("a local hop that is not trusted is reported as an ignored forwarded chain", () => {
  const attributed = requestSourceAttribution(fakeRequest({
    ip: "127.0.0.1",
    peer: "127.0.0.1",
    headers: { "x-forwarded-for": "203.0.113.9" },
  }));
  assert.equal(attributed.source, "127.0.0.1");
  assert.equal(attributed.sourceKind, "untrusted-forwarded");
  assert.deepEqual(attributed.forwardedChain, ["203.0.113.9"]);
});

test("the forwarded chain is cleaned, bounded and reports truncation", () => {
  const dirty = boundedForwardedChain(" 1.2.3.4 ,\r\n 5.6.7.8\u0000, , 9.9.9.9 ");
  assert.deepEqual(dirty.chain, ["1.2.3.4", "5.6.7.8", "9.9.9.9"]);
  assert.equal(dirty.truncated, false);
  assert.equal(boundedForwardedChain("").chain.length, 0);
  assert.equal(boundedForwardedChain(undefined).chain.length, 0);
  const long = Array.from({ length: FORWARDED_CHAIN_MAX_HOPS + 3 }, (_, index) => `10.0.0.${index}`).join(",");
  const bounded = boundedForwardedChain(long);
  assert.equal(bounded.chain.length, FORWARDED_CHAIN_MAX_HOPS);
  assert.equal(bounded.truncated, true);
  const attributed = requestSourceAttribution(fakeRequest({ ip: "10.0.0.1", peer: "10.0.0.1", headers: { "x-forwarded-for": long } }));
  assert.equal(attributed.forwardedChainTruncated, true);
  assert.equal(attributed.forwardedChain.length, FORWARDED_CHAIN_MAX_HOPS);
});

// Real Express wiring: the predicate used for classification must be the one
// Express actually applied (`app.get("trust proxy fn")`), not a private copy.
async function probeApp(t, trustProxy) {
  const app = express();
  app.set("trust proxy", trustProxy);
  app.get("/probe", (req, res) => res.json({ ip: req.ip, ...requestSourceAttribution(req) }));
  const server = app.listen(await fetchSafePort(), "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("Express: an untrusted direct peer's forged XFF is ignored (LAN regression)", async (t) => {
  const origin = await probeApp(t, false);
  const direct = await (await fetch(`${origin}/probe`)).json();
  assert.equal(direct.source, "127.0.0.1");
  assert.equal(direct.sourceKind, "loopback");
  const forged = await (await fetch(`${origin}/probe`, { headers: { "X-Forwarded-For": "203.0.113.5" } })).json();
  assert.equal(forged.ip, "127.0.0.1", "Express must keep ignoring XFF from an untrusted peer");
  assert.equal(forged.source, "127.0.0.1");
  assert.equal(forged.sourceTrusted, false);
  assert.equal(forged.sourceKind, "untrusted-forwarded", "the ignored chain is still recorded, not silently adopted");
  assert.deepEqual(forged.forwardedChain, ["203.0.113.5"]);
});

test("Express: a configured trusted hop adopts the forwarded client", async (t) => {
  const origin = await probeApp(t, "127.0.0.1, 10.0.0.55");
  const adopted = await (await fetch(`${origin}/probe`, { headers: { "X-Forwarded-For": "198.51.100.8" } })).json();
  assert.equal(adopted.source, "198.51.100.8");
  assert.equal(adopted.ip, adopted.source);
  assert.equal(adopted.sourcePeer, "127.0.0.1");
  assert.equal(adopted.sourceTrusted, true);
  assert.equal(adopted.sourceTrustedEntry, "127.0.0.1, 10.0.0.55");
  assert.equal(adopted.sourceKind, "trusted-proxy");
  // No XFF: Express keeps the peer, and no trust is claimed from a mere config match.
  const noHeader = await (await fetch(`${origin}/probe`)).json();
  assert.equal(noHeader.source, "127.0.0.1");
  assert.equal(noHeader.sourceTrusted, false);
  assert.equal(noHeader.sourceKind, "loopback");
});

test("TRUST_PROXY stays an explicit allowlist; no unconditional trust proxying", () => {
  const appRoot = path.resolve(import.meta.dirname, "..");
  const serverConfig = fs.readFileSync(path.join(appRoot, "src", "server-config.js"), "utf8");
  assert.match(serverConfig, /TRUST_PROXY=true is not allowed/);
  const files = ["server.js"];
  for (const entry of fs.readdirSync(path.join(appRoot, "src"), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".js")) files.push(path.join("src", entry.name));
  }
  for (const relative of files) {
    const content = fs.readFileSync(path.join(appRoot, relative), "utf8");
    assert.doesNotMatch(content, /set\(\s*["']trust proxy["']\s*,\s*true\s*\)/, `${relative} must not enable trust proxy unconditionally`);
  }
});
