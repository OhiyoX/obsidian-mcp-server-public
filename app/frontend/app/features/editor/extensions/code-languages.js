import { cssLanguage } from "@codemirror/lang-css";
import { htmlLanguage } from "@codemirror/lang-html";
import { javascriptLanguage, jsxLanguage, tsxLanguage, typescriptLanguage } from "@codemirror/lang-javascript";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { StreamLanguage } from "@codemirror/language";
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
import { codeLanguageKey } from "../../document/code-tokens.js";

// Live Preview fence languages. Keeping this map keyed by the shared
// `codeLanguageKey` vocabulary means the Reader highlighter and the Live editor
// parse exactly the same set of fences — the parser behind a key differs per
// surface (CodeMirror's own languages here, LegacyMode stream parsers for the
// vocabularies CM6 does not ship; the Reader pairs the same keys with Lezer /
// stream parsers of its own).
const streamLanguage = (spec) => StreamLanguage.define(spec);

const LIVE_LANGUAGES = new Map([
  ["javascript", javascriptLanguage],
  ["jsx", jsxLanguage],
  ["typescript", typescriptLanguage],
  ["tsx", tsxLanguage],
  ["css", cssLanguage],
  ["html", htmlLanguage],
  // #482 vocabulary.
  ["shell", streamLanguage(shell)],
  ["powershell", streamLanguage(powerShell)],
  ["python", streamLanguage(python)],
  ["json", streamLanguage(json)],
  ["yaml", streamLanguage(yaml)],
  ["sql", streamLanguage(standardSQL)],
  ["go", streamLanguage(go)],
  ["rust", streamLanguage(rust)],
  ["java", streamLanguage(java)],
  ["c", streamLanguage(c)],
  ["cpp", streamLanguage(cpp)],
  ["diff", streamLanguage(diff)],
  ["markdown", markdownLanguage],
  ["xml", streamLanguage(xml)],
  ["toml", streamLanguage(toml)],
  ["dockerfile", streamLanguage(dockerFile)],
]);

/** `markdown({ codeLanguages })` resolver: fence info -> CodeMirror Language. */
export function liveCodeLanguageForFence(info) {
  const key = codeLanguageKey(info);
  return key ? LIVE_LANGUAGES.get(key) || null : null;
}

export const LIVE_CODE_LANGUAGE_KEYS = [...LIVE_LANGUAGES.keys()];
