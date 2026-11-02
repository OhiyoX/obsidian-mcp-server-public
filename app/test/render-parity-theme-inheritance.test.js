// Phase 1-A offline guards for the "real theme.css inheritance" gate.
//
// The bounded Chromium gate (`scripts/render-parity-phase1-theme.mjs`) owns the
// computed-paint proof. These fast checks keep the fixture, the expectation
// table and the cascade layers from silently drifting apart between runs:
//
//   1. every RenderKind in the TODO matrix is in the gate KINDS list;
//   2. the fixture CSS literally declares every sentinel the gate asserts;
//   3. themeable code-fence paint stays OUT of the late-injected EditorView
//      theme and IN the static, earlier app.css layer under a :where() scope
//      that a community theme can out-specify.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EXPECTED, KINDS, kindProps, mutateValue, validateFixture } from "../scripts/render-parity-theme-core.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(appRoot, relative), "utf8");

const REQUIRED_KINDS = [
  "heading1", "paragraph", "strong", "emphasis", "strikethrough", "highlight",
  "link-external", "link-internal", "tag", "inline-code", "code-block", "quote",
  "callout", "footnote", "embed-image",
  "list", "task", "task-checked", "table", "hr",
  "code-keyword", "code-string", "code-comment", "code-number",
];

test("theme inheritance gate covers every committed RenderKind", () => {
  const covered = new Set(KINDS.map((kind) => kind.id));
  for (const kind of REQUIRED_KINDS) assert.ok(covered.has(kind), `gate is missing RenderKind ${kind}`);
  for (const kind of KINDS) {
    assert.ok(kind.reader.selector || kind.reader.needle, `${kind.id} needs a Reader anchor`);
    assert.ok(kind.props.reader.length, `${kind.id} needs Reader props`);
    if (kind.live) {
      assert.ok(kind.live.selector || kind.live.needle, `${kind.id} needs a Live anchor`);
      assert.ok(kind.props.live.length, `${kind.id} needs Live props`);
    } else {
      assert.deepEqual(kind.props.live, [], `${kind.id} must make no Live claim without a Live anchor`);
    }
  }
});

test("callout / footnote / embed kinds keep U15's Reader anchors and add a Live anchor", () => {
  // U15 owns the Reader side of these three kinds: its Reader anchors and every
  // value they assert must stay exactly as merged. This slice only ADDS the Live
  // anchor for the same canonical face (the Live callout block widget renders
  // through the shared Reader renderer, the Live footnote definition line
  // carries `.HyperMD-footnote`, and the Live image embed stays in-place wiki
  // chrome), so the gate no longer makes a "no Live claim" assertion for them.
  for (const id of ["callout", "footnote", "embed-image"]) {
    const kind = KINDS.find((entry) => entry.id === id);
    assert.ok(kind, `gate is missing RenderKind ${id}`);
    assert.ok(kind.reader.selector || kind.reader.needle, `${id} needs a Reader anchor`);
    assert.ok(kind.props.reader.length, `${id} needs Reader props`);
    assert.ok(kind.live, `${id} needs a Live anchor now that the Live face exists`);
    assert.ok(kind.live.selector || kind.live.needle, `${id} needs a Live anchor`);
    assert.ok(kind.props.live.length, `${id} needs Live props`);
    // The negative control can only prove inheritance when every asserted value
    // actually moves under the mutation transform, on both hosts.
    for (const prop of kindProps(kind)) {
      assert.notEqual(mutateValue(EXPECTED[id][prop]), EXPECTED[id][prop], `${id}.${prop} must mutate`);
    }
  }
  // U15's Reader anchors (unchanged by this slice).
  assert.equal(KINDS.find((kind) => kind.id === "callout").reader.climb, ".callout");
  assert.equal(KINDS.find((kind) => kind.id === "footnote").reader.selector, "#preview .footnotes");
  assert.equal(
    KINDS.find((kind) => kind.id === "embed-image").reader.selector,
    "#preview img.internal-embed.image-embed",
  );
  // The Live anchors this slice adds.
  assert.equal(KINDS.find((kind) => kind.id === "callout").live.selector, ".cm-callout .callout");
  assert.equal(KINDS.find((kind) => kind.id === "footnote").live.climb, ".HyperMD-footnote");
  assert.equal(KINDS.find((kind) => kind.id === "embed-image").live.climb, ".internal-embed.image-embed");
});

test("callout / footnote / embed fixture rules use canonical Obsidian selectors", () => {
  const css = read("test/fixtures/render-parity-theme-fixture.css");
  // Desktop app.css 11262 keys callouts on `[data-callout="…"]`; a
  // `callout-<type>` class is a Web invention and must not reappear.
  assert.match(css, /\.callout\[data-callout="note"\]/);
  assert.match(css, /\.markdown-preview-view \.footnotes\b/);
  assert.match(css, /\.markdown-preview-view img\.internal-embed\b/);
});

test("fixture declares every sentinel the gate asserts", () => {
  const css = read("test/fixtures/render-parity-theme-fixture.css");
  assert.deepEqual(validateFixture(css), []);
  // The fixture must be a plausible theme, not a Web copy: it must not leak the
  // private cm-live-* classes as its only entry point.
  assert.match(css, /\.HyperMD-header-1/);
  assert.match(css, /\.HyperMD-codeblock/);
  assert.match(css, /\.cm-inline-code/);
  assert.match(css, /\.cm-hashtag/);
});

test("code-token fixture uses the canonical Obsidian class faces", () => {
  const css = read("test/fixtures/render-parity-theme-fixture.css");
  // Live: the Desktop app.css `.cm-*` family; Reader: the `.token *` family a
  // statically highlighted rendered code block carries. The fixture must target
  // the canonical faces, never a Web-only class.
  for (const className of ["cm-keyword", "cm-string", "cm-comment", "cm-number"]) {
    assert.match(css, new RegExp(`\\.${className}\\b`), `fixture must target .${className} on Live`);
  }
  for (const className of ["keyword", "string", "comment", "number"]) {
    assert.match(css, new RegExp(`\\.token\\.${className}\\b`), `fixture must target .token.${className} on Reader`);
  }
  // At least one Live token rule must use the BARE (0,1,0) selector shape a real
  // theme uses (`Things/theme.css:584` `.cm-keyword { ... }`), so the gate
  // empirically proves a low-specificity theme selector beats the fallback.
  assert.match(css, /(^|[,}])\s*\.cm-keyword\s*,\s*\.token\.keyword\s*\{/m);
});

test("code-token expectations stay mutable for the negative control", () => {
  for (const id of ["code-keyword", "code-string", "code-comment", "code-number"]) {
    const kind = KINDS.find((entry) => entry.id === id);
    assert.ok(kind, `gate is missing the ${id} kind`);
    assert.ok(kind.reader.selector, `${id} needs a Reader selector`);
    assert.ok(kind.live.selector, `${id} needs a Live selector`);
    // Every asserted prop must move under the mutation transform, otherwise the
    // negative control silently stops proving anything for this kind.
    for (const prop of kindProps(kind)) {
      assert.notEqual(mutateValue(EXPECTED[id][prop]), EXPECTED[id][prop], `${id}.${prop} must mutate`);
    }
  }
});

test("block-surface fixture uses the canonical Obsidian selector shapes", () => {
  const css = read("test/fixtures/render-parity-theme-fixture.css");
  // Callout: the BARE (0,1,0) shape a real theme ships, which also proves the
  // app.css fallback for the block stayed at zero specificity.
  assert.match(css, /(^|[,}])\s*\.callout\s*\{/m);
  // Embed / footnote: the faces Desktop declares (`app.css`), not a Web class.
  assert.match(css, /(^|[,}])\s*\.markdown-embed\s*\{/m);
  assert.match(css, /\.markdown-preview-view \.footnote-ref/);
  assert.match(css, /\.cm-s-obsidian \.cm-line\.HyperMD-footnote/);
  // Embed image: the Live in-place chrome reaches the canonical `.internal-embed`
  // span through the same scope the other Live rules use.
  assert.match(css, /\.markdown-source-view\.mod-cm6\.is-live-preview \.internal-embed\s*\{/);
});

test("callout / embed / footnote fallback paint lives in app.css at zero specificity", () => {
  const css = read("src/app/assets/app.css");
  // A (0,2,0) `.preview .callout` fallback would beat a theme's bare `.callout`
  // rule; the canonical fallback must stay reachable only through `:where()`.
  assert.equal(/\.preview \.callout\s*\{/.test(css), false, "fallback must not use a (0,2,0) .preview .callout scope");
  assert.match(css, /:where\(\.callout\)/);
  assert.match(css, /:where\(\.footnotes\)/);
  assert.match(css, /:where\(\.internal-embed:not\(\.image-embed\)\)/);
  assert.match(css, /:where\(\.markdown-source-view\.mod-cm6\) :where\(\.cm-line\.HyperMD-footnote\)/);
});

test("block-surface Live adapters emit Desktop's canonical class faces", () => {
  // Live only: the Reader callout / footnote / embed faces are pinned by U15's
  // `test/reader-callout-footnote-canonical.test.js`, and the BLOCK Reader module
  // that used to be read here (`reader/block-surfaces.js`) is gone.
  const calloutSource = read("frontend/app/features/editor/extensions/block-callout.js");
  const footnoteSource = read("frontend/app/features/editor/extensions/block-footnote.js");
  const embedSource = read("frontend/app/features/editor/extensions/block-embed.js");
  // Live callout: the Desktop block widget container plus the SHARED Reader
  // renderer (so the canonical callout DOM inside the widget is U15's).
  assert.ok(calloutSource.includes('"cm-callout cm-embed-block"'));
  assert.ok(calloutSource.includes("renderObsidianMarkdown"));
  assert.ok(footnoteSource.includes("HyperMD-footnote"));
  assert.ok(footnoteSource.includes("cm-hmd-footnote"));
  assert.ok(embedSource.includes('"cm-live-wiki-link"'));
  assert.ok(embedSource.includes('"internal-embed", "image-embed"'));
  assert.ok(embedSource.includes('"internal-embed", "file-embed"'));
  assert.ok(embedSource.includes('"internal-embed", "markdown-embed", "inline-embed"'));
});

test("completed-task fixture uses the canonical Obsidian/Things selector shapes", () => {
  const css = read("test/fixtures/render-parity-theme-fixture.css");
  // Reader: Things and Obsidian Desktop both narrow the completed item to
  // `.task-list-item.is-checked`; Desktop also declares the `[data-task="x"]`
  // item state. The fixture must cover both shapes, not a Web-only selector.
  assert.match(css, /\.markdown-preview-view ul > li\.task-list-item\.is-checked/);
  assert.match(css, /\.markdown-preview-view ul > li\.task-list-item\[data-task="x"\]/);
  // Live: Things and Desktop target the `HyperMD-task-line[data-task='x']` line
  // state; Desktop also sets the `is-checked` line class, so the class key is
  // covered as well.
  assert.match(css, /\.markdown-source-view\.mod-cm6 \.HyperMD-task-line\[data-task="x"\]/);
  assert.match(css, /\.markdown-source-view\.mod-cm6\.is-live-preview \.HyperMD-task-line\.is-checked/);
});

test("completed-task expectations stay mutable for the negative control", () => {
  const checked = KINDS.find((kind) => kind.id === "task-checked");
  assert.ok(checked, "gate is missing the completed-task kind");
  assert.ok(checked.reader.needle, "task-checked needs a Reader anchor");
  assert.ok(checked.live.needle, "task-checked needs a Live anchor");
  assert.deepEqual(EXPECTED["task-checked"], {
    color: "rgb(201, 202, 203)",
    textDecorationLine: "line-through",
    backgroundColor: "rgb(221, 222, 223)",
  });
  // Every asserted prop must move under the mutation transform, otherwise the
  // negative control silently stops proving anything for this kind.
  for (const prop of ["color", "textDecorationLine", "backgroundColor"]) {
    const mutated = mutateValue(EXPECTED["task-checked"][prop]);
    assert.notEqual(mutated, EXPECTED["task-checked"][prop], `${prop} must mutate`);
  }
});

test("themeable code-fence paint is not in the late-injected EditorView theme", () => {
  const themeSource = read("frontend/app/features/editor/extensions/theme.js");
  const fenceBlocks = [...themeSource.matchAll(/"(\.cm-live-code-[a-z-]+[^"]*)":\s*\{([^}]*)\}/g)];
  assert.ok(fenceBlocks.length >= 6, "expected the Live code-fence dynamic theme blocks");
  for (const [, selector, body] of fenceBlocks) {
    for (const prop of ["color", "backgroundColor", "borderTop", "borderBottom", "borderLeft", "borderRight", "borderTopLeftRadius", "borderBottomLeftRadius"]) {
      assert.equal(new RegExp(`${prop}:`).test(body), false, `${selector} must not declare themeable ${prop} in EditorView.theme`);
    }
  }
  assert.match(themeSource, /Code-fence paint lives in app\.css/);
});

test("app.css owns code-fence paint under a low-specificity :where() scope", () => {
  const css = read("src/app/assets/app.css");
  for (const selector of [
    ":where(.markdown-source-view.mod-cm6.is-live-preview) .cm-live-code-lang-line",
    ":where(.markdown-source-view.mod-cm6.is-live-preview) .cm-live-code-fence-line",
    ":where(.markdown-source-view.mod-cm6.is-live-preview) .cm-live-code-body",
  ]) {
    assert.ok(css.includes(selector), `app.css must carry the fallback for ${selector}`);
  }
  const langFenceRule = css.match(/:where\([^)]*\) \.cm-live-code-lang-line,\s*:where\([^)]*\) \.cm-live-code-fence-line \{([^}]*)\}/);
  assert.ok(langFenceRule, "code-fence language/fence fallback rule must exist");
  assert.match(langFenceRule[1], /color:\s*var\(--text-muted\)/);
  assert.match(langFenceRule[1], /background-color:\s*var\(--code-background/);
});
