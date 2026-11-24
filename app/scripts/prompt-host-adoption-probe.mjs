#!/usr/bin/env node
// Distinguish "the server serves the new prompt text" from "a host adopted it".
//
//   prompt-host-adoption-probe.mjs --url https://host/mcp [--api-key KEY] [--host-digest HEX]
//
// The probe only reads. It lists the tools the endpoint currently serves and prints
// a digest of their descriptions. `hostAdopted` is `true` only when the caller can
// supply the digest the host itself is using (for example from a client log) and it
// matches; `null` means nobody measured the host side. A `list_changed` notification
// alone never proves adoption.

import { createHash } from "node:crypto";
import process from "node:process";

export function descriptorDigest(tools) {
  const hash = createHash("sha256");
  for (const tool of [...tools].sort((left, right) => left.name.localeCompare(right.name))) {
    hash.update(`${tool.name}\u0000${tool.description ?? ""}\u0000`);
  }
  return hash.digest("hex");
}

export function classifyAdoption({ serverDigest, hostDigest }) {
  if (typeof hostDigest !== "string" || hostDigest === "") return null;
  return hostDigest === serverDigest;
}

function args(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    out[token.slice(2)] = argv[index + 1];
    index += 1;
  }
  return out;
}

async function main() {
  const flags = args(process.argv.slice(2));
  if (flags.url === undefined) {
    process.stderr.write("usage: prompt-host-adoption-probe.mjs --url URL [--api-key KEY] [--host-digest HEX]\n");
    return 2;
  }
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (flags["api-key"]) headers.authorization = `Bearer ${flags["api-key"]}`;
  const url = flags.url.replace(/\/$/, "");

  const init = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "prompt-adoption-probe", version: "1" } } }),
  });
  if (!init.ok) throw new Error(`initialize failed with HTTP ${init.status}`);
  const session = init.headers.get("mcp-session-id");

  const listed = await fetch(url, {
    method: "POST",
    headers: { ...headers, ...(session ? { "mcp-session-id": session } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  const body = await listed.text();
  // Streamable HTTP may answer as SSE; one `data:` line carries the JSON-RPC result.
  const payload = body.trimStart().startsWith("{")
    ? JSON.parse(body)
    : JSON.parse(body.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean).at(-1) ?? "{}");
  const tools = payload?.result?.tools ?? [];
  const serverDigest = descriptorDigest(tools);
  const report = {
    serverDigest,
    serverVisible: true,
    hostDigest: flags["host-digest"] ?? null,
    hostAdopted: classifyAdoption({ serverDigest, hostDigest: flags["host-digest"] }),
    toolCount: tools.length,
    observedAt: new Date().toISOString(),
    note: "hostAdopted=null means the host side was not measured; a notification is not adoption",
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`probe: ${error.message}\n`);
      process.exit(1);
    });
}
