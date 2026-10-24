import { StreamLanguage } from "@codemirror/language";
import { parser as cssParser } from "@lezer/css";
import { parser as htmlParser } from "@lezer/html";
import { highlightTree, tagHighlighter } from "@lezer/highlight";
import { parser as javascriptParser } from "@lezer/javascript";
import { parser as markdownParser } from "@lezer/markdown";
import { c, cpp, java } from "@codemirror/legacy-modes/mode/clike";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { go } from "@codemirror/legacy-modes/mode/go";
import { json } from "@codemirror/legacy-modes/mode/javascript";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { python } from "@codemirror/legacy-modes/mode/python";
import { rust } from "@codemirror/legacy-modes/mode/rust";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { standardSQL } from "@codemirror/legacy-modes/mode/sql";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { xml } from "@codemirror/legacy-modes/mode/xml";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { READER_CODE_TOKEN_FACES, codeLanguageKey } from "../document/code-tokens.js";

/*
 * Reader-side code-block highlighting.
 *
 * Obsidian Desktop highlights rendered code blocks with the canonical
 * `token <name>` class face (see `code-tokens.js`), so the same Vault theme
 * rule paints a Reader code block and a Live code block.
 *
 * Desktop reaches that face through Prism's 373 languages in Reading mode while
 * its Live Preview highlights with CodeMirror. The Web keeps one fence vocabulary
 * for both surfaces (`codeLanguageKey`) and lets each side pick a parser per key:
 * a Lezer parser where one exists, and a `@codemirror/legacy-modes` StreamLanguage
 * otherwise (#482 explicitly allows this route). Stream parsers are read straight
 * off `StreamLanguage.define(spec).parser`, so the Reader never touches the editor
 * runtime — no `EditorView`, no `EditorState`.
 */

const READER_HIGHLIGHTER = tagHighlighter(
  READER_CODE_TOKEN_FACES.map((face) => ({ tag: face.tags, class: face.class })),
);

/** A legacy stream parser, used through its Lezer `Parser` face. */
const streamParser = (spec) => StreamLanguage.define(spec).parser;

const READER_PARSERS = new Map([
  ["javascript", javascriptParser],
  ["jsx", javascriptParser.configure({ dialect: "jsx" })],
  ["typescript", javascriptParser.configure({ dialect: "ts" })],
  ["tsx", javascriptParser.configure({ dialect: "jsx ts" })],
  ["css", cssParser],
  ["html", htmlParser],
  // #482 vocabulary: same keys as `LIVE_LANGUAGES`, parsers differ per surface.
  ["shell", streamParser(shell)],
  ["powershell", streamParser(powerShell)],
  ["python", streamParser(python)],
  ["json", streamParser(json)],
  ["yaml", streamParser(yaml)],
  ["sql", streamParser(standardSQL)],
  ["go", streamParser(go)],
  ["rust", streamParser(rust)],
  ["java", streamParser(java)],
  ["c", streamParser(c)],
  ["cpp", streamParser(cpp)],
  ["diff", streamParser(diff)],
  ["markdown", markdownParser],
  ["xml", streamParser(xml)],
  ["toml", streamParser(toml)],
  ["dockerfile", streamParser(dockerFile)],
]);

export const READER_CODE_LANGUAGE_KEYS = [...READER_PARSERS.keys()];

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

/**
 * markdown-it `highlight` hook for fenced code. Returns "" for a language we
 * cannot tokenize, which makes markdown-it escape the block itself.
 */
export function highlightFencedCode(code, info) {
  const key = codeLanguageKey(info);
  const parser = key ? READER_PARSERS.get(key) : null;
  if (!parser) return "";
  const source = String(code ?? "");
  let html = "";
  let position = 0;
  highlightTree(parser.parse(source), READER_HIGHLIGHTER, (from, to, classes) => {
    if (from > position) html += escapeHtml(source.slice(position, from));
    html += `<span class="${classes}">${escapeHtml(source.slice(from, to))}</span>`;
    position = to;
  });
  return html + escapeHtml(source.slice(position));
}
