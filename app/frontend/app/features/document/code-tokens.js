import { tags } from "@lezer/highlight";

/*
 * Canonical Obsidian code-token class faces, plus the fence-language alias
 * table shared by the Live (CodeMirror) and Reader (static) highlighters.
 *
 * Class names are NOT invented here. They were extracted verbatim from the
 * Obsidian Desktop `app.css` "Syntax highlighting" block
 * (`<Obsidian>/resources/obsidian.asar` -> `app.css`):
 *
 *   Live (CodeMirror 6 token class):
 *     .cm-comment, .cm-meta                 { color: var(--code-comment); }
 *     .cm-number                            { color: var(--code-value); }
 *     .cm-qualifier, .cm-string, .cm-string-2 { color: var(--code-string); }
 *     .cm-keyword                           { color: var(--code-keyword); }
 *
 *   Reader (static highlight of a rendered code block):
 *     .token.comment, .token.prolog, .token.doctype, .token.cdata { color: var(--code-comment); }
 *     .token.boolean, .token.number         { color: var(--code-value); }
 *     .token.string, .token.char, .token.inserted { color: var(--code-string); }
 *     .token.regex, .token.important        { color: var(--code-important); }
 *     .token.keyword                        { color: var(--code-keyword); }
 *
 * `.cm-atom` is not declared by Desktop `app.css` itself; it is the canonical
 * CodeMirror-5 token style that real community themes target instead
 * (e.g. `Things/theme.css`: `.cm-variable-2, .cm-type, .cm-atom { ... }`).
 * Booleans are emitted as atoms by the legacy modes Desktop uses for fences,
 * so `tags.bool` shares that face.
 *
 * Both faces stay in lockstep with `--code-*`: the semantic token a tag
 * resolves to is the same on Reader and Live, and it is declared once, in
 * `app.css`, under a `:where()` scope so the Vault theme stays authoritative.
 */

export const LIVE_CODE_TOKEN_FACES = [
  { tags: [tags.keyword], class: "cm-keyword" },
  { tags: [tags.string], class: "cm-string" },
  { tags: [tags.special(tags.string), tags.regexp, tags.escape], class: "cm-string-2" },
  { tags: [tags.comment], class: "cm-comment" },
  { tags: [tags.meta], class: "cm-meta" },
  { tags: [tags.number, tags.integer, tags.float], class: "cm-number" },
  { tags: [tags.atom, tags.bool], class: "cm-atom" },
];

export const READER_CODE_TOKEN_FACES = [
  { tags: [tags.keyword], class: "token keyword" },
  { tags: [tags.string], class: "token string" },
  { tags: [tags.special(tags.string), tags.regexp, tags.escape], class: "token regex" },
  { tags: [tags.comment], class: "token comment" },
  { tags: [tags.number, tags.integer, tags.float], class: "token number" },
  { tags: [tags.atom, tags.bool], class: "token boolean" },
];

/*
 * Fence languages with a real parser on both surfaces. `codeLanguageKey`
 * normalizes the info string (```` ```JS title=x ```` -> "javascript") so the
 * Live and Reader registries can never disagree about which names are known.
 */
export const CODE_LANGUAGE_KEYS = [
  "javascript", "jsx", "typescript", "tsx", "css", "html",
  // #482: the fence vocabulary the issue asks for. Desktop highlights 373 Prism
  // languages in Reading mode; Live highlighting is CodeMirror's, so the two
  // surfaces stay in lockstep on this shared key list and each side picks its own
  // parser for the same key (Lezer where one exists, `@codemirror/legacy-modes`
  // StreamLanguage otherwise — the route #482 explicitly allows).
  "shell", "powershell", "python", "json", "yaml", "sql",
  "go", "rust", "java", "c", "cpp", "diff", "markdown", "xml", "toml", "dockerfile",
];

const LANGUAGE_ALIASES = new Map([
  ["js", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["javascript", "javascript"],
  ["node", "javascript"],
  ["jsx", "jsx"],
  ["ts", "typescript"],
  ["typescript", "typescript"],
  ["tsx", "tsx"],
  ["css", "css"],
  ["html", "html"],
  ["htm", "html"],
  ["xhtml", "html"],
  ["sh", "shell"],
  ["shell", "shell"],
  ["bash", "shell"],
  ["zsh", "shell"],
  ["console", "shell"],
  ["shell-session", "shell"],
  ["ps1", "powershell"],
  ["powershell", "powershell"],
  ["pwsh", "powershell"],
  ["py", "python"],
  ["python", "python"],
  ["python3", "python"],
  ["json", "json"],
  ["jsonc", "json"],
  ["yml", "yaml"],
  ["yaml", "yaml"],
  ["sql", "sql"],
  ["postgres", "sql"],
  ["postgresql", "sql"],
  ["mysql", "sql"],
  ["go", "go"],
  ["golang", "go"],
  ["rs", "rust"],
  ["rust", "rust"],
  ["java", "java"],
  ["c", "c"],
  ["h", "c"],
  ["cpp", "cpp"],
  ["c++", "cpp"],
  ["cc", "cpp"],
  ["cxx", "cpp"],
  ["hpp", "cpp"],
  ["diff", "diff"],
  ["patch", "diff"],
  ["md", "markdown"],
  ["markdown", "markdown"],
  ["xml", "xml"],
  ["svg", "xml"],
  ["toml", "toml"],
  ["dockerfile", "dockerfile"],
  ["docker", "dockerfile"],
]);

/** Normalize a fence info string to a `CODE_LANGUAGE_KEYS` entry, or "". */
export function codeLanguageKey(info) {
  const name = String(info ?? "").trim().split(/\s+/, 1)[0].toLowerCase();
  return LANGUAGE_ALIASES.get(name) || "";
}

/*
 * Display names for the shared fence vocabulary (#482 third slice). Desktop
 * derives them from CodeMirror 5's `findModeByName(info).name` (`PowerShell`,
 * `C++`, `Dockerfile`, `JavaScript`, …), which is a table by another name, so the
 * Web keeps an explicit one instead of guessing from capitalization. Every entry
 * matches the CM5 mode name; `tsx` has no CM5 mode (Desktop would print the raw
 * info string there) and takes the Web's own name because Web does parse it.
 */
export const CODE_LANGUAGE_LABELS = Object.freeze({
  javascript: "JavaScript",
  jsx: "JSX",
  typescript: "TypeScript",
  tsx: "TSX",
  css: "CSS",
  html: "HTML",
  shell: "Shell",
  powershell: "PowerShell",
  python: "Python",
  json: "JSON",
  yaml: "YAML",
  sql: "SQL",
  go: "Go",
  rust: "Rust",
  java: "Java",
  c: "C",
  cpp: "C++",
  diff: "Diff",
  markdown: "Markdown",
  xml: "XML",
  toml: "TOML",
  dockerfile: "Dockerfile",
});

/** Display name for a normalized key, or "" when the key has none. */
export function codeLanguageLabel(key) {
  return CODE_LANGUAGE_LABELS[key] || "";
}
