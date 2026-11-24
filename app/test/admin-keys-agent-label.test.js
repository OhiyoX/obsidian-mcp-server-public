// #285 — the API Key drawer's 「绑定 Agent」 row is a real, operator-set display label now.
//
// What this pins, all through the real `catalog.js` seam and the real page renderer:
//   * a bound label is what the drawer shows; an unbound key falls back to the User-Agent hint;
//   * the `规划中 #285` placeholder (and its `.futonly` row) is gone;
//   * the label is written by a scriptless POST form that carries `csrf` and `id` (no script);
//   * `zh-CN` and `en` carry the same key set (no half translation).
import assert from "node:assert/strict";
import test from "node:test";

import { buildCatalog } from "../src/admin/catalog.js";
import { renderKeysPage } from "../src/admin/pages/keys.js";
import { adminCatalogFor } from "../src/i18n/admin.js";

const CSRF = "csrf-agent-label";
const KEY_ID = "87ca7263-0f4e-4a1b-b6d9-3c5e81f20a7d";
const VAULTS = [{ id: "vault", name: "主库", primary: true }];

/** One managed key; `agentLabel === undefined` renders a record stored before #285. */
function snapshot(agentLabel, userAgent = "cursor/0.42 (darwin arm64)") {
  return {
    oauthUsers: [], clients: [], tokens: [], audit: [], configuredApiKeyUsage: {},
    apiKeys: [{
      id: KEY_ID,
      label: "桌面客户端",
      prefix: "obmcp_ab12cd34ef56",
      createdAt: "2026-09-10T03:00:00Z",
      lastUsedAt: userAgent === null ? null : "2026-10-12T04:00:00Z",
      lastSource: userAgent === null ? null : "192.168.1.31",
      lastUserAgent: userAgent,
      allowedScopes: ["obsidian.read"],
      allowedVaults: ["vault"],
      ...(agentLabel === undefined ? {} : { agentLabel }),
    }],
  };
}

async function renderKeys(agentLabel, userAgent) {
  const data = snapshot(agentLabel, userAgent);
  const provider = { ready: Promise.resolve(), authorizationSnapshot: async () => structuredClone(data) };
  const catalog = await buildCatalog({
    deps: { provider, listVaults: async () => ({ vaults: VAULTS }) },
    req: { headers: {} },
    query: { tab: "keys", id: KEY_ID },
    now: Date.parse("2026-10-12T08:00:00Z"),
  });
  return renderKeysPage({ ...catalog, csrf: CSRF, session: { csrf: CSRF }, constraintBase: "/admin/auth/authz" });
}

const stripTags = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("the drawer shows the label an operator bound to the key", async () => {
  const { detailPanel } = await renderKeys("pi-pocket");
  assert.match(stripTags(detailPanel), /绑定 Agent pi-pocket/);
  assert.doesNotMatch(stripTags(detailPanel), /按 UA 推断/, "a bound label is not a guess");

  // The list's 最后调用 cell carries the same label, so the operator sees it without opening the drawer.
  const { content } = await renderKeys("pi-pocket");
  assert.ok(content.includes('<div class="muted ell">pi-pocket</div>'), "the row must show the label too");

  // Negative control: an unbound key renders no such label line, so the assertion above can fail.
  const unbound = await renderKeys(undefined);
  assert.equal(unbound.content.includes('class="muted ell">pi-pocket</div>'), false);
});

test("an unbound key falls back to the User-Agent hint, never to a permission claim", async () => {
  const { detailPanel } = await renderKeys(undefined);
  assert.match(stripTags(detailPanel), /未设置（按 UA 推断：cursor）/);
  assert.match(stripTags(detailPanel), /显示用途/, "the row must say it is a display purpose");

  // A key with no User-Agent at all must not invent one (an empty UA is not "generic").
  const never = await renderKeys(undefined, null);
  assert.match(stripTags(never.detailPanel), /未设置（按 UA 推断：—）/);
});

test("the 规划中 #285 placeholder is gone from the page", async () => {
  const { content, detailPanel } = await renderKeys(undefined);
  const page = `${content}${detailPanel}`;
  assert.equal(page.includes("规划中"), false);
  assert.equal(page.includes("futonly"), false);
  assert.equal(page.includes("#285"), false);
});

test("the label is written by a scriptless form that carries csrf and id", async () => {
  const { detailPanel } = await renderKeys(undefined);
  const form = /<form class="dsec" method="post" action="\/admin\/auth\/api-key\/agent">([\s\S]*?)<\/form>/.exec(detailPanel);
  assert.ok(form, "the drawer must render the Agent label form");
  assert.match(form[1], new RegExp(`<input type="hidden" name="csrf" value="${CSRF}">`));
  assert.match(form[1], new RegExp(`<input type="hidden" name="id" value="${KEY_ID}">`));
  assert.match(form[1], /<input class="inp" name="agent" value="" maxlength="40"/);
  assert.equal(/<script|data-act=|onclick=/.test(detailPanel), false, "the Admin plane stays scriptless");
});

test("the Admin catalogs carry the same Agent-label keys", () => {
  const zh = adminCatalogFor("zh-CN");
  const en = adminCatalogFor("en");
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const key of ["adm.keys.agentInferred", "adm.keys.agentHelp", "adm.keys.agentPlaceholder", "adm.keys.saveAgent", "adm.keys.agentTooLong", "adm.keys.agentInvalid", "adm.router.flash.keyAgentUpdated", "adm.router.refuse.keyMissingAgent", "adm.router.error.keyAgentHeading"]) {
    assert.ok(zh[key]?.trim(), `zh-CN must define ${key}`);
    assert.ok(en[key]?.trim(), `en must define ${key}`);
  }
  assert.equal(zh["adm.keys.agentWhy"], undefined, "the retired placeholder copy must be deleted");
  assert.equal(en["adm.keys.agentWhy"], undefined);
});
