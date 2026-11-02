// Offline guards for the canonical code-token class face (unified rendering
// TODO §4 second item: "code/glyph 前景与语法色").
//
// The Chromium gates own the computed-paint proof. These fast checks keep the
// class face, the fallback layer and the two language registries from silently
// drifting apart:
//
//   1. Live/Reader expose exactly the canonical Obsidian class names extracted
//      from the Desktop `app.css` "Syntax highlighting" block (no invented ones);
//   2. the Live HighlightStyle is class-only, so no colour can escape the
//      `--code-*` semantic tokens;
//   3. app.css carries the fallback under a zero-specificity `:where()` scope,
//      so even a (0,1,0) community-theme selector wins;
//   4. the Reader highlighter emits the same canonical face and escapes HTML;
//   5. Live and Reader parse exactly the same fence-language vocabulary.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  CODE_LANGUAGE_KEYS,
  LIVE_CODE_TOKEN_FACES,
  READER_CODE_TOKEN_FACES,
  codeLanguageKey,
} from "../frontend/app/features/document/code-tokens.js";
import { READER_CODE_LANGUAGE_KEYS, highlightFencedCode } from "../frontend/app/features/reader/code-highlight.js";
import { LIVE_CODE_LANGUAGE_KEYS } from "../frontend/app/features/editor/extensions/code-languages.js";

const css = await fs.readFile(new URL("../src/app/assets/app.css", import.meta.url), "utf8");
const themeSource = await fs.readFile(
  new URL("../frontend/app/features/editor/extensions/theme.js", import.meta.url),
  "utf8",
);
const createEditorSource = await fs.readFile(
  new URL("../frontend/app/features/editor/create-editor.js", import.meta.url),
  "utf8",
);
const readerSource = await fs.readFile(
  new URL("../frontend/app/features/reader/reader.js", import.meta.url),
  "utf8",
);

// Extracted verbatim from Obsidian Desktop `app.css` (see `code-tokens.js`).
const DESKTOP_LIVE_CLASSES = ["cm-keyword", "cm-string", "cm-string-2", "cm-comment", "cm-meta", "cm-number", "cm-atom"];
const DESKTOP_READER_CLASSES = ["token keyword", "token string", "token regex", "token comment", "token number", "token boolean"];

test("Live code tokens expose the canonical Desktop class face", () => {
  const classes = LIVE_CODE_TOKEN_FACES.map((face) => face.class);
  assert.deepEqual([...classes].sort(), [...DESKTOP_LIVE_CLASSES].sort());
  for (const face of LIVE_CODE_TOKEN_FACES) {
    assert.ok(Array.isArray(face.tags) && face.tags.length > 0, `${face.class} needs at least one lezer tag`);
    assert.match(face.class, /^cm-[a-z0-9-]+$/, `${face.class} must be a canonical cm-* class`);
    assert.doesNotMatch(face.class, /cm-web|web-/, `${face.class} must not invent a Web-only class`);
  }
});

test("Reader code tokens expose the canonical Desktop token face", () => {
  const classes = READER_CODE_TOKEN_FACES.map((face) => face.class);
  assert.deepEqual([...classes].sort(), [...DESKTOP_READER_CLASSES].sort());
  for (const face of READER_CODE_TOKEN_FACES) {
    assert.match(face.class, /^token [a-z0-9-]+$/, `${face.class} must be a canonical token class`);
  }
});

test("Live HighlightStyle assigns classes only, never colours", () => {
  const defineCall = themeSource.match(/export const obsidianHighlight = HighlightStyle\.define\(([\s\S]*?)\n\);/);
  assert.ok(defineCall, "obsidianHighlight must be a HighlightStyle.define(...) call");
  assert.doesNotMatch(defineCall[1], /color:|background|textDecoration|fontStyle/, "code-token HighlightStyle must not declare paint");
  assert.match(defineCall[1], /LIVE_CODE_TOKEN_FACES/, "obsidianHighlight must consume the shared canonical face list");
  // The editor must actually parse fence languages, otherwise the canonical
  // classes can never appear on a token.
  assert.match(createEditorSource, /markdown\(\{ extensions: GFM, codeLanguages: liveCodeLanguageForFence \}\)/);
});

test("app.css owns the code-token fallback under a zero-specificity :where() scope", () => {
  const liveTokens = [
    [".cm-keyword", "--code-keyword"],
    [".cm-string", "--code-string"],
    [".cm-string-2", "--code-string"],
    [".cm-comment", "--code-comment"],
    [".cm-meta", "--code-comment"],
    [".cm-number", "--code-value"],
    [".cm-atom", "--code-keyword"],
  ];
  for (const [className, token] of liveTokens) {
    const rule = css.match(new RegExp(`:where\\([^)]*\\${className}\\b[^)]*\\)\\s*\\{([^}]*)\\}`));
    assert.ok(rule, `app.css must carry a :where() fallback for ${className}`);
    assert.match(rule[1], new RegExp(`var\\(${token}\\b`), `${className} fallback must come from ${token}`);
  }
  const readerTokens = [
    [".token.keyword", "--code-keyword"],
    [".token.string", "--code-string"],
    [".token.regex", "--code-important"],
    [".token.comment", "--code-comment"],
    [".token.number", "--code-value"],
    [".token.boolean", "--code-value"],
  ];
  for (const [className, token] of readerTokens) {
    const escaped = className.replace(/[.]/g, "\\.");
    const rule = css.match(new RegExp(`:where\\([^)]*${escaped}\\b[^)]*\\)\\s*\\{([^}]*)\\}`));
    assert.ok(rule, `app.css must carry a :where() fallback for ${className}`);
    assert.match(rule[1], new RegExp(`var\\(${token}\\b`), `${className} fallback must come from ${token}`);
  }
  // A bare (non-:where) code-token rule would out-specify a low-specificity
  // community-theme selector and break theme inheritance.
  for (const className of DESKTOP_LIVE_CLASSES) {
    assert.doesNotMatch(css, new RegExp(`(^|[,}])\\s*\\${className}\\s*[,{]`, "m"), `${className} must not be declared outside :where()`);
  }
});

test("Reader fence highlight emits canonical token classes and escapes HTML", () => {
  const html = highlightFencedCode("const x = \"<b>&\" // c\n", "js");
  assert.match(html, /<span class="token keyword">const<\/span>/);
  assert.match(html, /<span class="token string">&quot;&lt;b&gt;&amp;&quot;<\/span>/);
  assert.match(html, /<span class="token comment">\/\/ c<\/span>/);
  assert.doesNotMatch(html, /<b>/, "code text must be escaped, never injected as HTML");
  // #482 vocabulary: the languages the issue names now highlight through the same
  // canonical face (stream parsers for the ones CodeMirror does not ship).
  assert.match(highlightFencedCode("print('x')\n", "python"), /<span class="token string">&#39;x&#39;<\/span>/);
  assert.match(highlightFencedCode("echo \"hi\"\n", "bash"), /<span class="token string">/, "the `bash` alias reaches the shell parser");
  assert.match(highlightFencedCode("SELECT id FROM t WHERE id = 1\n", "sql"), /<span class="token keyword">SELECT<\/span>/);
  assert.match(highlightFencedCode("key: value\n", "yaml"), /<span class="token /);
  assert.equal(highlightFencedCode("print('x')", "made-up-lang"), "", "an unknown fence language stays unhighlighted");
  assert.equal(highlightFencedCode("", "js"), "");
});

test("Live and Reader parse the same fence-language vocabulary", () => {
  assert.deepEqual([...LIVE_CODE_LANGUAGE_KEYS].sort(), [...CODE_LANGUAGE_KEYS].sort());
  assert.equal(codeLanguageKey("JS"), "javascript");
  assert.equal(codeLanguageKey("ts title=demo.ts"), "typescript");
  assert.equal(codeLanguageKey("  HTML  "), "html");
  // #482: the requested vocabulary normalizes onto the shared keys, aliases included.
  for (const [info, key] of [
    ["powershell", "powershell"], ["pwsh", "powershell"], ["ps1", "powershell"],
    ["shell", "shell"], ["bash", "shell"], ["zsh", "shell"],
    ["python", "python"], ["py", "python"],
    ["json", "json"], ["yaml", "yaml"], ["yml", "yaml"], ["sql", "sql"],
    ["go", "go"], ["golang", "go"], ["rust", "rust"], ["rs", "rust"],
    ["java", "java"], ["c", "c"], ["cpp", "cpp"], ["c++", "cpp"], ["hpp", "cpp"],
    ["diff", "diff"], ["patch", "diff"], ["markdown", "markdown"], ["md", "markdown"],
    ["xml", "xml"], ["svg", "xml"], ["toml", "toml"], ["dockerfile", "dockerfile"],
  ]) {
    assert.equal(codeLanguageKey(info), key, `${info} must normalize to ${key}`);
  }
  assert.equal(codeLanguageKey("made-up-lang"), "");
  assert.equal(codeLanguageKey(""), "");
  // Both surfaces must actually carry a parser for every shared key (a key in the
  // vocabulary list without a parser would silently render as plain text again).
  assert.deepEqual([...READER_CODE_LANGUAGE_KEYS].sort(), [...CODE_LANGUAGE_KEYS].sort());
  // The Reader hook must be wired into the markdown-it instance.
  assert.match(readerSource, /highlight: highlightFencedCode/);
});
