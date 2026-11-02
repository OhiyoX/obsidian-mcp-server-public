import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { appPage } from "../src/app/pages.js";
import { ICON_SPRITE_ATTR } from "../frontend/app/ui/icons.js";

const css = await fs.readFile(new URL("../src/app/assets/app.css", import.meta.url), "utf8");
const treeSource = await fs.readFile(new URL("../frontend/app/features/explorer/tree.js", import.meta.url), "utf8");
const draftSource = await fs.readFile(new URL("../frontend/app/features/explorer/create-draft.js", import.meta.url), "utf8");
const appSource = await fs.readFile(new URL("../frontend/app/core/app.js", import.meta.url), "utf8");
const html = appPage({ csrf: "csrf", username: "tester", displayName: "Tester" }, { colorMode: "dark", themeId: "Things" });

function between(start, end) {
  const from = html.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = html.indexOf(end, from);
  assert.notEqual(to, -1, `missing ${end}`);
  return html.slice(from, to);
}

// U38 (#571): the shell publishes the sprite URL *with its content hash* on `<html>` — the very
// attribute `ui/icons.js` resolves — and each SSR reference repeats it character for character, so
// a bare `icons.svg#<symbol>` literal is exactly what the one-year `immutable` entry would pin.
const publishedSpriteUrl = (markup) => new RegExp(`<html[^>]*\\s${ICON_SPRITE_ATTR}="([^"]+)"`).exec(markup)?.[1] ?? null;
const escapeRegExp = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("desktop ribbon is navigation chrome, not a logo strip", () => {
  const ribbon = between('<aside class="ribbon', '</aside>');
  assert.match(ribbon, /id="files-toggle"/);
  assert.doesNotMatch(ribbon, /class="mark"/);
  assert.doesNotMatch(ribbon, /id="settings-open"/);
  assert.doesNotMatch(ribbon, /action="\/auth\/logout"/);
  assert.match(css, /\.ribbon \{[\s\S]*?background:\s*var\(--app-chrome-bg/);
  assert.match(css, /\.ribbon \.icon-btn\.active \{[\s\S]*?background:\s*var\(--app-sidebar-active-bg/);
  assert.doesNotMatch(css, /\.ribbon \.icon-btn\.active \{[^}]*background:\s*var\(--accent\)/);
});

test("file toolbar contains only file-scope actions", () => {
  const actions = between('<div class="sidebar-actions"', '</div>');
  assert.doesNotMatch(actions, /id="new-note"/);
  assert.match(actions, /id="reveal-active"/);
  assert.match(actions, /id="publishes-open"/);
  assert.doesNotMatch(actions, /id="settings-open"/);
  assert.doesNotMatch(actions, /action="\/auth\/logout"/);
});

test("settings and account actions live in the sidebar footer", () => {
  const footer = between('<footer class="sidebar-footer">', '</footer>');
  assert.match(footer, /id="vault-select"/);
  assert.match(footer, /id="vault-create"/);
  const published = publishedSpriteUrl(html);
  assert.match(published ?? "", /^\/app\/assets\/icons\.svg\?v=[0-9a-f]{16}$/, "the shell must publish the content-hashed sprite URL");
  assert.match(footer, new RegExp(`<use href="${escapeRegExp(published)}#database">`));
  assert.doesNotMatch(footer, /class="search-help/);
  assert.match(footer, /id="settings-open"/);
  assert.match(footer, /action="\/auth\/logout"/);
  assert.doesNotMatch(footer, /class="app-release/);
  assert.match(css, /\.vault-switcher \{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) repeat\(3, 28px\)/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.vault-switcher \{[^}]*repeat\(3, 44px\)/);
});

test("search syntax help and inline controls stay adjacent to the search field", () => {
  const searchRow = between('<div class="search-row">', '<div id="search-status"');
  assert.match(searchRow, /id="search"/);
  assert.match(searchRow, /id="search-clear"/);
  assert.match(searchRow, /id="search-case"[^>]*>Aa<\/button>/);
  assert.match(searchRow, /id="semantic-search"/);
  assert.match(searchRow, /class="search-help"/);
  assert.doesNotMatch(css, /\.sidebar-footer \.search-help-card/);
});


test("release identity lives inside settings instead of sidebar chrome", () => {
  const settings = between('<dialog id="settings-dialog"', '</dialog>');
  assert.match(settings, /class="settings-meta"/);
  assert.match(settings, /class="settings-meta-version"/);
  assert.match(settings, />Obsidian Web</);
  assert.match(css, /\.settings-meta \{[^}]*border-top:\s*1px solid var\(--background-modifier-border\)/);
  assert.doesNotMatch(css, /\.app-release(?:\s|\{|\.)/);
});


test("new note creation is contextual to folder rows and never uses a browser prompt", () => {
  // #427: the inline draft row (and its input) moved to features/explorer/create-draft.js;
  // the renderer keeps the contextual folder-row `+` and its commit seam.
  assert.match(treeSource, /className = "tree-folder-add"/);
  assert.match(treeSource, /onCommit: \(name\) => onCreateNote\?\.\(scope, name\)/);
  assert.match(draftSource, /input\.className = isFolder \? "note-create-input folder-create-input" : "note-create-input"/);
  assert.match(css, /\.tree-folder-row:hover \.tree-folder-add,[\s\S]*?opacity:\s*1/);
  assert.doesNotMatch(appSource, /prompt\("新笔记路径"/);
  assert.doesNotMatch(appSource, /#new-note/);
});
