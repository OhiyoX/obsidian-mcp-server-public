// Live code-block flair (#482, third slice) — the language label at the top-right
// of an idle fence, and the Live copy affordance Desktop puts on the same widget.
//
// Covers the pure decisions (label lookup, body slice, widget DOM, click-to-copy
// with its transient result) on a headless DOM, plus the stylesheet/geometry
// literals that carry the parity claim. The real-browser face (position inside the
// code block, hidden while the block is being edited, clipboard contents) is the
// lane's Chromium probe, not this file.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { GFM } from "@lezer/markdown";
import { createDomHarness } from "./helpers/base-dom.mjs";
import {
  CODE_LANGUAGE_KEYS,
  CODE_LANGUAGE_LABELS,
  codeLanguageLabel,
} from "../frontend/app/features/document/code-tokens.js";
import { COPY_LABELS } from "../frontend/app/features/document/code-copy.js";
import {
  CodeBlockFlairWidget,
  FLAIR_CLASS,
  FLAIR_HOST_CLASS,
  codeBlockBody,
  codeBlockFlairLabel,
  paintFlair,
} from "../frontend/app/features/editor/extensions/code-block-flair.js";

const dom = createDomHarness();
dom.install();

const css = await fs.readFile(new URL("../src/app/assets/app.css", import.meta.url), "utf8");
const themeSource = await fs.readFile(
  new URL("../frontend/app/features/editor/extensions/theme.js", import.meta.url),
  "utf8",
);
const liveSource = await fs.readFile(
  new URL("../frontend/app/features/editor/extensions/live-decorations.js", import.meta.url),
  "utf8",
);

function stateOf(doc, selection) {
  return EditorState.create({ doc, selection, extensions: [markdown({ extensions: GFM })] });
}

/** The first `FencedCode` of a document, in both shapes the app deals with. */
function fenceOf(doc, selection) {
  const state = stateOf(doc, selection);
  let captured = null;
  let capturedRef = null;
  syntaxTree(state).iterate({
    enter(node) {
      if (captured || node.name !== "FencedCode") return;
      // Both reads must happen *inside* the callback: a `SyntaxNodeRef` is only
      // valid during iteration, and reading `ref.node` afterwards is how the first
      // version of this helper silently handed the tests a stale node.
      captured = node.node;
      capturedRef = { name: node.name, from: node.from, to: node.to, node: node.node };
    },
  });
  return { state, node: captured, ref: capturedRef };
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

function clipboardStub() {
  const writes = [];
  return { writes, navigator: { clipboard: { writeText: async (text) => writes.push(text) } } };
}

function glyphTags(host) {
  const svg = host.querySelector("svg");
  if (!svg) return "none";
  return (svg.childNodes ?? [])
    .filter((child) => child.nodeType === 1)
    .map((child) => String(child.tagName).toLowerCase())
    .join("+");
}

test("every shared fence key has a display name, and the tricky ones are explicit", () => {
  for (const key of CODE_LANGUAGE_KEYS) {
    const label = codeLanguageLabel(key);
    assert.ok(label, `${key} must have a display name (Desktop prints one for it)`);
  }
  // Desktop's names come from CodeMirror 5's mode table; these are the ones a
  // capitalization guess would get wrong.
  assert.equal(codeLanguageLabel("cpp"), "C++");
  assert.equal(codeLanguageLabel("c"), "C");
  assert.equal(codeLanguageLabel("dockerfile"), "Dockerfile");
  assert.equal(codeLanguageLabel("shell"), "Shell");
  assert.equal(codeLanguageLabel("powershell"), "PowerShell");
  assert.equal(codeLanguageLabel("javascript"), "JavaScript");
  assert.equal(codeLanguageLabel("sql"), "SQL");
  assert.equal(codeLanguageLabel("json"), "JSON");
  assert.equal(codeLanguageLabel("yaml"), "YAML");
  assert.equal(codeLanguageLabel("unknown-key"), "");
  assert.equal(Object.keys(CODE_LANGUAGE_LABELS).length, CODE_LANGUAGE_KEYS.length, "the table covers the vocabulary exactly");
});

test("the label comes from the fence info string, through the shared alias table", () => {
  for (const [info, expected] of [
    ["js", "JavaScript"],
    ["py", "Python"],
    ["ts", "TypeScript"],
    ["cpp", "C++"],
    ["dockerfile", "Dockerfile"],
    ["js title=App", "JavaScript"],
    [" js ", "JavaScript"],
    ["zzz", ""],
    ["", ""],
  ]) {
    const { state, node } = fenceOf(`\`\`\`${info}\ncode\n\`\`\`\n`);
    assert.equal(codeBlockFlairLabel(state, node), expected, `info ${JSON.stringify(info)}`);
  }
});

test("a fence with no info string has no label — Desktop paints the copy icon there", () => {
  const { state, node } = fenceOf("```\nplain\n```\n");
  assert.equal(codeBlockFlairLabel(state, node), "");
  assert.equal(codeBlockBody(state, node), "plain");
});

test("the body is the fence content, including for an unclosed fence", () => {
  const closed = fenceOf("```js\nconst a = 1;\nconst b = 2;\n```\n");
  assert.equal(codeBlockBody(closed.state, closed.node), "const a = 1;\nconst b = 2;");
  // An unclosed fence keeps its last newline here; the copy strips exactly one, so
  // the clipboard still gets "unclosed line" — Desktop's own line arithmetic would
  // drop that line entirely, which is why this uses Lezer's `CodeText` child.
  const unclosed = fenceOf("```js\nunclosed line\n");
  assert.equal(codeBlockBody(unclosed.state, unclosed.node), "unclosed line\n");
});

// Independent review F1 (blocker): `syntaxTree().iterate()` hands the decoration
// pass a `SyntaxNodeRef`, which has no `getChild` — reading it straight off the Ref
// made the `CodeText` path dead code and an unclosed fence at EOF copied an empty
// string while the flair announced "已复制". These pins exercise the **real** call
// shape, not just the friendly `SyntaxNode` one.
test("the helpers accept the SyntaxNodeRef the decoration pass actually passes", () => {
  const eof = fenceOf("body\n\n```rust\nunclosed tail\n");
  assert.equal(typeof eof.ref.getChild, "undefined", "the Ref really has no getChild (the trap)");
  assert.equal(codeBlockBody(eof.state, eof.ref), "unclosed tail\n", "an unclosed fence at EOF must not copy an empty string");
  assert.equal(codeBlockFlairLabel(eof.state, eof.ref), "Rust", "the label must resolve through the Ref too");
  const mid = fenceOf("```rust\nunclosed tail\n\nTrailing paragraph.\n\n```python\nprint(1)\n```\n");
  assert.equal(
    codeBlockBody(mid.state, mid.ref),
    "unclosed tail\n\nTrailing paragraph.\n\n```python\nprint(1)",
    // Lezer treats everything after an unclosed fence as that fence's content, so the
    // nested fence markers are part of the body — no line is dropped, which is the
    // property under test (the pre-fix line slice cut the last line instead).
    "an unclosed fence keeps every line, including the fences that follow it",
  );
  // The friendly shape keeps working as well (both call sites stay honest).
  assert.equal(codeBlockBody(eof.state, eof.node), "unclosed tail\n");
  assert.equal(codeBlockFlairLabel(eof.state, eof.node), "Rust");
});

test("the fallback slice also stops at the last line for an unclosed fence", () => {
  // An empty fence has no `CodeText` child, so the fallback runs; it must not drop
  // the final line the way Desktop's own arithmetic does.
  const empty = fenceOf("```js\n```\n");
  assert.equal(codeBlockBody(empty.state, empty.ref), "", "an empty fence copies nothing");
  const unclosedEmpty = fenceOf("```js\n");
  assert.equal(codeBlockBody(unclosedEmpty.state, unclosedEmpty.ref), "");
  // A body-less-but-multiline case that exercises the slice path: an indented fence
  // with no closing mark and no CodeText is not reachable, so this asserts the
  // closed slice boundary instead.
  const closed = fenceOf("```js\nline one\nline two\n```\n");
  assert.equal(codeBlockBody(closed.state, closed.ref), "line one\nline two");
});

test("a labelled flair shows the name and carries no icon", () => {
  const host = new CodeBlockFlairWidget("C++", "int x;").toDOM();
  assert.equal(host.getAttribute("class"), FLAIR_CLASS);
  assert.equal(host.textContent, "C++");
  assert.equal(host.getAttribute("role"), "button");
  assert.equal(host.getAttribute("data-flair-label"), "C++");
  assert.equal(host.getAttribute("data-copy-state"), "idle");
  assert.equal(host.getAttribute("aria-label"), "复制 C++ 代码");
  assert.equal(host.getAttribute("title"), "复制 C++ 代码");
  assert.equal(glyphTags(host), "none", "Desktop's labelled flair has no icon");
});

test("a flair without a label is the copy icon, exactly like Desktop's Z5", () => {
  const host = new CodeBlockFlairWidget("", "plain").toDOM();
  assert.equal(host.textContent, "");
  assert.equal(host.getAttribute("data-flair-label"), "");
  assert.equal(host.getAttribute("aria-label"), COPY_LABELS.idle);
  assert.equal(glyphTags(host), "rect+path", "the inline copy glyph");
  assert.equal(host.querySelector("svg").getAttribute("viewBox"), "0 0 24 24");
  assert.equal(host.querySelector("use"), null, "no sprite reference (see the copy-icon module)");
});

test("clicking the flair copies the code and paints the result until the timer fires", async () => {
  const clipboard = clipboardStub();
  const queued = [];
  const host = new CodeBlockFlairWidget("JavaScript", "const a = 1;", {
    navigator: clipboard.navigator,
    setTimeout: (fn, ms) => { queued.push({ fn, ms }); return 0; },
  }).toDOM();
  host.click();
  await settle();
  assert.deepEqual(clipboard.writes, ["const a = 1;"], "one trailing newline is stripped, as in Desktop's Nj()");
  assert.equal(host.getAttribute("data-copy-state"), "copied");
  assert.equal(host.classList.contains("is-copied"), true);
  assert.equal(host.getAttribute("aria-label"), COPY_LABELS.copied);
  assert.equal(host.textContent, "JavaScript", "the label stays put; the result is painted, not swapped in");
  assert.equal(queued.length, 1);
  assert.equal(queued[0].ms, 1000, "Desktop restores the icon after one second");
  queued[0].fn();
  assert.equal(host.getAttribute("data-copy-state"), "idle");
  assert.equal(host.classList.contains("is-copied"), false);
  assert.equal(host.getAttribute("aria-label"), "复制 JavaScript 代码");
});

test("an icon-only flair swaps to the check glyph on a successful copy", async () => {
  const clipboard = clipboardStub();
  const queued = [];
  const host = new CodeBlockFlairWidget("", "plain", {
    navigator: clipboard.navigator,
    setTimeout: (fn) => { queued.push(fn); return 0; },
  }).toDOM();
  host.click();
  await settle();
  assert.equal(glyphTags(host), "path", "the copied state paints the check");
  queued[0]();
  assert.equal(glyphTags(host), "rect+path", "and restores the copy glyph");
});

test("a failed copy is visible and announced, never silent", async () => {
  const queued = [];
  const host = new CodeBlockFlairWidget("Python", "print(1)", {
    navigator: { clipboard: { writeText: async () => { throw new Error("denied"); } } },
    setTimeout: (fn, ms) => { queued.push({ fn, ms }); return 0; },
  }).toDOM();
  host.click();
  await settle();
  assert.equal(host.getAttribute("data-copy-state"), "failed");
  assert.equal(host.classList.contains("is-copy-failed"), true);
  assert.equal(host.getAttribute("aria-label"), COPY_LABELS.failed);
  assert.equal(queued[0].ms, 1600, "the failure lingers longer than the success");
  queued[0].fn();
  assert.equal(host.getAttribute("data-copy-state"), "idle");
});

test("paintFlair keeps a labelled flair's text and only repaints its state", () => {
  const host = dom.createElement("span");
  host.setAttribute("data-flair-label", "Go");
  host.textContent = "Go";
  paintFlair(host, "copied");
  assert.equal(host.textContent, "Go");
  assert.equal(host.classList.contains("is-copied"), true);
  paintFlair(host, "failed");
  assert.equal(host.textContent, "Go");
  assert.equal(host.classList.contains("is-copied"), false);
  assert.equal(host.classList.contains("is-copy-failed"), true);
});

test("eq compares label and body, so CodeMirror rebuilds the widget when either moves", () => {
  const base = new CodeBlockFlairWidget("Go", "x := 1");
  assert.equal(base.eq(new CodeBlockFlairWidget("Go", "x := 1")), true);
  assert.equal(base.eq(new CodeBlockFlairWidget("Go", "x := 2")), false);
  assert.equal(base.eq(new CodeBlockFlairWidget("Rust", "x := 1")), false);
});

test("app.css carries Desktop's flair values, on tokens", () => {
  const start = css.indexOf(":where(.markdown-source-view.mod-cm6.is-live-preview) .code-block-flair {");
  const end = css.indexOf("/* Live code-fence paint");
  assert.ok(start > 0 && end > start, "the flair rule must exist");
  const block = css.slice(start, end);
  for (const literal of [
    "position: absolute;",
    "right: 6px;",
    "top: 6px;",
    "z-index: 1;",
    "display: inline-block;",
    "padding: var(--size-4-1) var(--size-4-2);",
    "border-radius: var(--code-block-radius);",
    "font-family: var(--font-interface);",
    "font-size: var(--font-ui-smaller);",
    "color: var(--text-muted);",
    "cursor: var(--cursor, pointer);",
  ]) {
    assert.ok(block.includes(literal), `the flair rule must carry \`${literal}\``);
  }
  assert.equal(/#[0-9a-f]{3,8}\b/i.test(block), false, "the flair must be token-driven, never a hardcoded colour");
  assert.match(
    css,
    /@media \(hover: hover\) \{\s*:where\(\.markdown-source-view\.mod-cm6\.is-live-preview\) \.code-block-flair:hover \{\s*background-color: var\(--background-modifier-hover\);\s*\}/,
    "Desktop's hover face uses the theme's hover modifier",
  );
  assert.match(css, /\.code-block-flair\.is-copied \{\s*color: var\(--text-success, var\(--color-green\)\);/, "a successful copy is announced in colour");
  assert.match(css, /\.code-block-flair\.is-copy-failed \{\s*color: var\(--text-error, var\(--color-red\)\);/, "a failed copy must be visible");
});

test("theme.js hosts the flair on the opening fence line without clipping it", () => {
  assert.match(
    themeSource,
    /"\.cm-live-code-lang-line\.cm-live-code-flair-host": \{\s*position: "relative",\s*overflow: "visible",\s*\}/,
    "the fence line is the containing block and must not clip a taller flair",
  );
  // The base rule keeps its own clipping, so an edited fence still clips its text.
  assert.match(themeSource, /"\.cm-live-code-lang-line, \.cm-live-code-fence-line": \{[\s\S]*?overflow: "hidden",/, "the fence strip still clips its own text");
});

test("the decoration pass emits the flair only while the block is idle", () => {
  assert.match(liveSource, /import \{ CodeBlockFlairWidget, FLAIR_HOST_CLASS, codeBlockBody, codeBlockFlairLabel \} from "\.\/code-block-flair\.js";/);
  assert.match(liveSource, /const flairLabel = codeBlockFlairLabel\(view\.state, node\.node\);/, "the label comes from the fence node");
  assert.match(liveSource, /const flairCode = blockActive \? "" : codeBlockBody\(view\.state, node\.node\);/, "the body must be sliced from the node (review F1)");
  assert.match(
    liveSource,
    /if \(!blockActive\) \{\s*ranges\.push\(Decoration\.widget\(\{\s*widget: new CodeBlockFlairWidget\(flairLabel, flairCode\),\s*side: 1,\s*\}\)\.range\(line\.to\)\);/,
    "the widget sits at the end of the opening fence line, like Desktop's",
  );
  assert.match(liveSource, /FLAIR_HOST_CLASS\}`\}/, "the host class is added to the opening fence line");
});

test("the built editor bundle carries the flair", async () => {
  const bundle = await fs.readFile(new URL("../src/app/assets/editor.js", import.meta.url), "utf8");
  assert.match(bundle, /code-block-flair/, "editor.js must be rebuilt with the flair");
  assert.equal(bundle.includes("icons.svg#copy"), false, "the flair must not reintroduce a sprite copy reference");
});
