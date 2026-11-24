// The Admin drawer and `server_info` report a Vault's capabilities from the canonical registry
// descriptor. Measured 2026-11-21 on the live deployment: the process had a working embedding
// provider (`EMBEDDING_PROVIDER=openai`, `qwen3-embedding-4b-q6`, `enabled:true`) while the Admin
// said 语义检索 unavailable and the hint read "本机未配置向量服务" — 10/13 instead of 11/13.
//
// The static graph `wiredCapabilities()` reports `semantic` unavailable by construction, because the
// real fact is a composite: retrieval is wired per Vault AND the process-shared provider is enabled.
// This file pins the composition that merges the two, in both directions.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

const APP_ROOT = new URL("..", import.meta.url);

/** One fresh process per case: the embedding provider is configured at module evaluation. */
function capabilitiesUnder(env) {
  const script = [
    'const { capabilitiesForVault } = await import("./src/app/vault-registry.js");',
    'console.log(JSON.stringify(capabilitiesForVault({ id: "vault" })));',
  ].join(" ");
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: APP_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return JSON.parse(output.trim().split("\n").at(-1));
}

test("a configured embedding provider makes `semantic` available, as the process actually is (#276 follow-up)", () => {
  const capabilities = capabilitiesUnder({
    EMBEDDING_PROVIDER: "openai",
    EMBEDDING_BASE_URL: "http://127.0.0.1:11435/v1",
    EMBEDDING_MODEL: "qwen3-embedding-4b-q6",
    EMBEDDING_API_KEY: "test-key-not-used",
  });
  assert.equal(capabilities.semantic?.available, true, "the provider is enabled, so the capability is real");
  // The other wired keys must be untouched by the merge.
  for (const key of ["notes", "files", "history", "trash", "git", "memory", "skills", "plans", "publish", "retrieval"]) {
    assert.equal(capabilities[key]?.available, true, `${key} stays wired`);
  }
});

test("without a provider the capability stays unavailable, and the Web-plane keys stay refused", () => {
  const capabilities = capabilitiesUnder({ EMBEDDING_PROVIDER: "disabled", EMBEDDING_BASE_URL: "", EMBEDDING_MODEL: "" });
  assert.equal(capabilities.semantic?.available, false, "no provider ⇒ no semantic recall, said honestly");
  // `webCatalog` and `events` are Web-plane facts with no MCP consumer; they stay false with a reason
  // rather than being quietly dropped from the map.
  for (const key of ["webCatalog", "events"]) {
    assert.equal(capabilities[key]?.available, false, `${key} is not an MCP capability`);
    assert.match(String(capabilities[key]?.reason ?? ""), /\S/, `${key} must carry the recorded reason, not an empty one`);
  }
});
