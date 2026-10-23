// Shared source-scanning helper for the vault-runtime Wave A lanes (A1/A2).
//
// Why a helper: several lanes must assert "this pure module imports only
// `node:*` built-ins and never reads `process.env`" (contract §43-5) and the same
// naive-regex scan must not be re-implemented per test file. This is a *test*
// helper with no runtime role.
//
// `maskSource` is a tiny JS scanner (not a parser): it blanks comments and any
// string/backtick body that is not an import specifier, so `// process.env` in a
// comment or `"import x from './y.js'"` inside a string cannot produce a false
// positive. `importSpecifiers` then extracts only real static import specifiers.

export function maskSource(source) {
  let out = "";
  let index = 0;
  let state = "code";
  let keep = false;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (state === "code") {
      if (char === "/" && next === "/") { state = "line"; out += "  "; index += 2; continue; }
      if (char === "/" && next === "*") { state = "block"; out += "  "; index += 2; continue; }
      if (char === "'" || char === '"') { keep = /(?:from|import)\s*$/.test(out); state = char === "'" ? "sq" : "dq"; out += char; index += 1; continue; }
      if (char === "`") { state = "tpl"; out += char; index += 1; continue; }
      out += char; index += 1; continue;
    }
    if (state === "line") { out += char === "\n" ? char : " "; if (char === "\n") state = "code"; index += 1; continue; }
    if (state === "block") {
      if (char === "*" && next === "/") { state = "code"; out += "  "; index += 2; continue; }
      out += char === "\n" ? char : " "; index += 1; continue;
    }
    if (state === "tpl") {
      if (char === "\\") { out += "  "; index += 2; continue; }
      if (char === "`") { state = "code"; out += char; index += 1; continue; }
      out += char === "\n" ? char : " "; index += 1; continue;
    }
    if (char === "\\") { out += keep ? char + (next ?? "") : "  "; index += 2; continue; }
    if (char === (state === "sq" ? "'" : '"')) { state = "code"; out += char; index += 1; continue; }
    out += keep ? char : " "; index += 1; continue;
  }
  return out;
}

/** Static import specifiers of a module source, in source order. */
export function importSpecifiers(source) {
  const regex = /\bimport\s*(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']/g;
  return [...maskSource(source).matchAll(regex)].map((match) => match[1]);
}
