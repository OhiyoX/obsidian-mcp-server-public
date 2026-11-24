// #669 (first slice): the overview's Agent connect block must state what this deployment really
// offers — the endpoint it can actually be reached at, the transport, the enabled auth modes — and
// the templates must carry a placeholder, never a key. A deployment without an HTTPS public base
// URL says so instead of printing a URL a public host cannot reach.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderOverviewPage } from "../src/admin/pages/overview.js";

function ctx(overrides = {}) {
  return {
    model: {
      keyOf: () => null, keyName: () => "—", client: () => null, clientName: () => "—",
      acct: () => null, acctName: () => "—",
    },
    snapshot: { oauthUsers: [], clients: [], audit: [] },
    keys: [], grants: [], publishCounts: { active: 0, total: 0 }, vaults: [], transfers: [], publications: [],
    constraintPage: { constraints: [], available: true },
    ...overrides,
  };
}

test("an HTTPS public base URL becomes the endpoint, with both client classes", () => {
  const { content } = renderOverviewPage(ctx({ publicBaseUrl: "https://mcp.example.invalid/", oauthEnabled: true, apiKeyEnabled: true }));
  assert.match(content, /<span class="mono">https:\/<wbr>\/<wbr>mcp\.example\.invalid\/<wbr>mcp<\/span>/, "the endpoint is the public base URL plus /mcp, with break points at the slashes");
  assert.match(content, /Streamable HTTP/);
  assert.match(content, /OAuth 2\.1 \+ PKCE · API Key 请求头/);
  assert.match(content, /Bearer &lt;API_KEY&gt;/, "the API key template carries a placeholder, escaped for markup");
  assert.doesNotMatch(content, /Bearer\s+[A-Za-z0-9_-]{16,}/, "no real-looking token may appear");
  assert.doesNotMatch(content, /未配置 PUBLIC_BASE_URL/, "a public deployment must not warn");
});

test("a missing or non-HTTPS public base URL is reported instead of printing a usable-looking address", () => {
  for (const publicBaseUrl of ["", "http://mcp.example.com"]) {
    const { content } = renderOverviewPage(ctx({ publicBaseUrl, oauthEnabled: true, apiKeyEnabled: true }));
    assert.match(content, /未配置 HTTPS 的 PUBLIC_BASE_URL/, `the block must say why ${JSON.stringify(publicBaseUrl)} is unusable`);
    assert.doesNotMatch(content, /Bearer &lt;API_KEY&gt;\n/, "no template may present the endpoint as ready");
  }
});

test("OAuth disabled says so instead of printing an OAuth template", () => {
  const { content } = renderOverviewPage(ctx({ publicBaseUrl: "https://mcp.example.com", oauthEnabled: false, apiKeyEnabled: true }));
  assert.match(content, /本部署未启用 OAuth/);
  assert.match(content, /API Key 请求头/, "the remaining mode is still stated");
  assert.doesNotMatch(content, /OAuth 2\.1 \+ PKCE ·/, "the auth row must not claim OAuth");
});

test("a read-only deployment says write tools are absent", () => {
  const { content } = renderOverviewPage(ctx({ publicBaseUrl: "https://mcp.example.com", readOnly: true, apiKeyEnabled: true }));
  assert.match(content, /当前部署只读：写入类工具不注册/);
});
