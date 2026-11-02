// The three data-driven Admin tabs (clients / tokens / publishes) render a table for desktop and a
// card list for phones from the *same* template expression: `table(...) + mcards(...)`. On a phone
// the table must be hidden by CSS (`.tw.hide-m` inside the ≤720px block) and the cards must carry the
// rows. The fixture used by the layout gate has no rows for these tabs, so nothing exercised that
// pairing with data — this test does, without a browser.
//
// A full geometry check with real rows lives outside the suite for now (probe-m15-rows.mjs in
// scratch); here we pin the invariant that can rot silently: the pairing, and the `hide-m` marker the
// phone CSS keys on.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = (file) => import(pathToFileURL(path.join(APP, "src", "admin", file)).href);

const { createModel } = await load("presentation/model.js");
const { renderTokensPage } = await load("pages/tokens.js");
const { renderPublishesPage } = await load("pages/publishes.js");
const { renderClientsPage } = await load("pages/clients.js");

const LONG_ID = "c9f1e0d2-6a4b-4f7c-9e51-2ab7d3c4e5f6";
const vaults = [{ id: "vault", label: "Vault" }, { id: "team-notes-and-a-very-long-secondary-vault-id", label: "Team notes" }];

const grants = Array.from({ length: 9 }, (_, index) => ({
  id: `grant-${index}`,
  status: ["active", "active", "rotated", "revoked"][index % 4],
  clientId: LONG_ID,
  vaults: ["vault", "team-notes-and-a-very-long-secondary-vault-id"],
  scopes: ["notes:read", "notes:write"],
  issued: { createdAt: new Date(Date.UTC(2026, 9, 20 - index, 12)).toISOString() },
  primaryTokenId: `tok_${index}`,
}));
const publications = Array.from({ length: 8 }, (_, index) => ({
  id: `pub-${index}`,
  path: `Notes/2026/Deep/Nested/Folder/a-very-long-document-name-${index}.md`,
  status: index % 3 === 0 ? "active" : "revoked",
  createdAt: new Date(Date.UTC(2026, 9, 18 - index, 9)).toISOString(),
  vaultId: "vault",
}));
const clients = Array.from({ length: 6 }, (_, index) => ({
  clientId: `${LONG_ID}-${index}`,
  clientName: `Obsidian Desktop ${index}`,
  redirectUris: [`https://app.example.invalid/cb/${index}`],
  createdAt: new Date(Date.UTC(2026, 8, 1 + index)).toISOString(),
}));

const model = createModel({ snapshot: { tokens: grants, apiKeys: [], clients }, keys: [], vaults, publications, query: {} });
const ctx = {
  model, query: {}, csrf: "t", flash: null, origin: "http://127.0.0.1:1",
  helpers: { fmtTime: () => "2026-10-20 12:00", rel: () => "3 天前" },
};
const content = (result) => (result && typeof result === "object" ? String(result.content ?? "") : String(result));

const SCENES = [
  ["tokens", () => content(renderTokensPage({ ...ctx, grants })), grants.length],
  ["publishes", () => content(renderPublishesPage({ ...ctx, publications })), publications.length],
  ["clients", () => content(renderClientsPage({ ...ctx, clients, transfers: [], snapshot: { clients, oauthUsers: [{ id: "acct-1", username: "gate" }] } })), clients.length],
];

for (const [name, render, rows] of SCENES) {
  test(`${name}: every table row set keeps the phone card list`, () => {
    const html = render();
    const tables = html.match(/<div class="tw hide-m">/g) || [];
    const cardLists = html.match(/<div class="mcards">/g) || [];
    assert.equal(tables.length, 1, `${name} renders exactly one table wrapper`);
    assert.equal(cardLists.length, 1, `${name} renders exactly one card list`);
    // The phone CSS hides `.tw.hide-m` below 720px; the marker is what makes the pair work, so a
    // table rendered without it would stay visible on a phone with no way to scroll it.
    assert.equal((html.match(/<table class="tbl">/g) || []).length, 1, `${name} renders the desktop table`);
    assert.equal((html.match(/<div class="mc">/g) || []).length, rows, `${name} renders one card per row`);
  });
}

// Sensitivity of the check above, on real output: delete the card list (or the hide-m marker) from a
// rendered page and the same measurement must notice. Without this the three assertions could pass on
// a page that has silently stopped emitting either half.
test("the pairing measurement is sensitive to a real regression", () => {
  const html = SCENES[0][1]();
  const withoutCards = html.replace('<div class="mcards">', '<div class="mcards-disabled">');
  const withoutMarker = html.replace('<div class="tw hide-m">', '<div class="tw">');
  assert.equal((html.match(/<div class="mcards">/g) || []).length, 1);
  assert.equal((withoutCards.match(/<div class="mcards">/g) || []).length, 0, "dropping the card list is detected");
  assert.equal((withoutMarker.match(/<div class="tw hide-m">/g) || []).length, 0, "dropping the phone marker is detected");
});

test("empty data keeps the phone surface usable (wrapper + empty state, no table)", () => {
  const html = content(renderTokensPage({ ...ctx, grants: [] }));
  assert.equal((html.match(/<table class="tbl">/g) || []).length, 0, "no desktop table for an empty list");
  assert.equal((html.match(/<div class="tw hide-m">/g) || []).length, 1, "the wrapper still exists so the empty state shows on desktop");
  assert.equal((html.match(/<div class="mcards">/g) || []).length, 0, "no card list for an empty list");
});
