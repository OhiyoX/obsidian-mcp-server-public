// Block-style line locator for `.base` surgical patches (A4a, pure module).
//
// js-yaml 4 exposes no CST / node positions, so a byte-exact patch needs a line
// scanner of its own. This one is deliberately narrow: block mappings and block
// sequences with the standard 2-space progression, nothing else. Every line is
// kept as `{ text, eol }` so CRLF/LF mixes, byte-exact re-emission and the
// presence or absence of a final newline survive a patch untouched.
//
// The module owns the "this document cannot be addressed" failure
// (`base-not-patchable`) because that judgement is exactly what the scanner
// makes; the mutation/whitelist layer lives in `base-patch.js`.
//
// Purity: no fs / path / express / MCP import.

export const BASE_PATCH_ERROR_CODES = Object.freeze(["base-not-patchable", "base-unknown-key"]);

export class BasePatchError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "BasePatchError";
    this.code = code;
  }
}

// Fail closed, and say what the caller can do instead: silent re-serialisation
// (`yaml.dump`) would drop comments, key order and quote style.
export const notPatchable = (why) =>
  new BasePatchError(`Base is not line-patchable: ${why} (use MCP \`write_base\` to rewrite the whole document)`, "base-not-patchable");

const DEFAULT_EOL = "\n";

export const splitLines = (raw) =>
  (raw.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((part) => {
    if (!part.endsWith("\n")) return { text: part, eol: "" };
    const body = part.slice(0, -1);
    return body.endsWith("\r") ? { text: body.slice(0, -1), eol: "\r\n" } : { text: body, eol: "\n" };
  });

// `lead` is the separator an inserted line had to *add* because the line before it had no
// terminator of its own; it is new bytes, never an edit to an existing line (see `insertLines`).
export const joinLines = (lines) => lines.map((line) => (line.lead ?? "") + line.text + line.eol).join("");

// Block rules: a `- ` marker consumes its own two columns, so `  - type: table`
// has dashIndent 2 and content indent 4.
export function tokenize(text) {
  const offset = /^[ \t]*/.exec(text)[0].length;
  const after = text.slice(offset);
  if (after.startsWith("- ")) {
    return { comment: false, dash: true, dashIndent: offset, indent: offset + 2, bodyOffset: offset + 2, body: after.slice(2) };
  }
  if (after === "" || after.startsWith("#")) {
    return { comment: true, dash: false, dashIndent: offset, indent: offset, bodyOffset: offset, body: "" };
  }
  return { comment: false, dash: false, dashIndent: offset, indent: offset, bodyOffset: offset, body: after };
}

export const decodeKey = (raw) => {
  if (/^"(?:[^"\\]|\\.)*"$/.test(raw)) return JSON.parse(raw);
  if (/^'(?:[^']|'')*'$/.test(raw)) return raw.slice(1, -1).replaceAll("''", "'");
  return raw;
};

// `prefix` ends where the value starts, so replacing a value touches exactly the
// value bytes and keeps the document's own spacing after the colon.
export function readKeyEntry(token) {
  const match = /^([^\s#][^:]*?):([ \t]*)(.*)$/.exec(token.body);
  if (!match) return null;
  return { key: decodeKey(match[1]), prefix: token.body.slice(0, token.body.length - match[3].length), value: match[3] };
}

// Quotes are masked before the scan so an `&`, `[` or `#` inside a quoted scalar
// (a formula string, say) is not a false rejection.
function maskQuoted(text) {
  let out = "";
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) {
        if (quote === "'" && text[index + 1] === "'") {
          out += "  ";
          index += 1;
          continue;
        }
        if (quote !== '"' || text[index - 1] !== "\\") quote = null;
      }
      out += " ";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      out += " ";
      continue;
    }
    out += char;
  }
  return out;
}

// The target region is the enclosing block of the addressed key. Anchors,
// aliases, flow collections and inline comments inside it mean the block cannot
// be addressed line-by-line, so the whole patch is refused.
export function assertPatchableRegion(lines, from, to) {
  for (let index = from; index < to; index += 1) {
    const text = lines[index].text;
    if (/^[ \t]*(?:#|$)/.test(text)) continue;
    const masked = maskQuoted(text);
    const why = /\t/.test(text)
      ? "tab indentation"
      : /(^|[\s,:[{-])&[A-Za-z0-9_-]+/.test(masked)
        ? "YAML anchor"
        : /(^|[\s,:[{-])\*[A-Za-z0-9_-]+/.test(masked)
          ? "YAML alias"
          : /[{}\[\]]/.test(masked)
            ? "flow (inline) collection"
            : /(^|\s)#/.test(masked)
              ? "inline comment"
              : null;
    if (why) throw notPatchable(`${why} on line ${index + 1}`);
  }
}

export function findTopLevelEntry(lines, key) {
  for (let index = 0; index < lines.length; index += 1) {
    const token = tokenize(lines[index].text);
    if (!token || token.comment || token.dash || token.indent !== 0) continue;
    const entry = readKeyEntry(token);
    if (entry && entry.key === key) return { line: index, entry };
  }
  return null;
}

// The lines belonging to the value of the key at `keyLine`; `childIndent` is the
// indent of the first child line (a block sequence reports its dash indent).
export function blockRange(lines, keyLine, keyIndent) {
  let end = keyLine;
  let childIndent = null;
  for (let index = keyLine + 1; index < lines.length; index += 1) {
    const token = tokenize(lines[index].text);
    if (!token || token.comment) continue;
    if (token.indent <= keyIndent) break;
    childIndent ??= token.dash ? token.dashIndent : token.indent;
    end = index;
  }
  return { start: keyLine + 1, end: end + 1, childIndent };
}

// End of the block's content, ignoring trailing blank and comment-only lines.
export function contentEnd(lines, from, to) {
  for (let index = to - 1; index >= from; index -= 1) {
    if (!tokenize(lines[index].text)?.comment) return index + 1;
  }
  return from;
}

export function mappingEntries(lines, from, to, indent, stopAtDash = null) {
  const entries = new Map();
  for (let index = from; index < to; index += 1) {
    const token = tokenize(lines[index].text);
    if (!token || token.comment) continue;
    if (stopAtDash !== null && token.dash && token.dashIndent === stopAtDash && index > from) break;
    if (token.indent !== indent) continue;
    const entry = readKeyEntry(token);
    if (!entry) throw notPatchable(`line ${index + 1} is not a block mapping entry`);
    if (!entries.has(entry.key)) entries.set(entry.key, { line: index, indent, ...entry });
  }
  return entries;
}

// The document's own terminator style, used only when there is no adjacent line to copy it from.
const documentEol = (lines, before) => {
  for (let index = before - 1; index >= 0; index -= 1) if (lines[index].eol !== "") return lines[index].eol;
  return DEFAULT_EOL;
};

// Purity (BRIEF-FIX-PROVENANCE, R4): never mutate an existing line object. Editing the previous
// line's `eol` in place is what made an unaddressed line look *replaced* to the provenance
// snapshot, so it got rebuilt from a lossy decode. Appending to a document whose last line has no
// terminator now writes the separator as new leading bytes on the first inserted line (`lead`),
// keeps the previous line byte-identical, and tags every new line `kind: "inserted"` so the byte
// splice can tell an append from a structural edit.
export function insertLines(lines, at, texts) {
  const previous = at > 0 ? lines[at - 1] : null;
  const next = at < lines.length ? lines[at] : null;
  const eol = (previous && previous.eol) || (next && next.eol) || documentEol(lines, at);
  // Appending to a document that had no final newline must not invent one: the last inserted line
  // keeps `eol: ""`, and the separator lives in the first inserted line's `lead`.
  const opensWithSeparator = Boolean(previous && previous.eol === "" && !next);
  lines.splice(
    at,
    0,
    ...texts.map((text, index) => ({
      text,
      eol: index === texts.length - 1 && opensWithSeparator ? "" : eol,
      ...(index === 0 && opensWithSeparator ? { lead: eol } : {}),
      kind: "inserted",
    })),
  );
}

// BRIEF-FIX-PROVENANCE (R4 NO-GO on `f6da3c44`): a line *count* is necessary but not sufficient —
// "delete k lines, insert k lines" keeps the total and still has no byte mapping. The invariant
// that actually matters is per line: every line a byte splice emits is either the original line it
// was copied from, byte for byte, or a line this patch was explicitly asked to write. On a document
// whose decode is lossy the patch is therefore refused unless
//   * every emitted line is `kept`, `replaced` or `inserted` — never an untracked rewrite;
//   * every original line still fills its own slot, in order and none missing (`kept.source` or
//     `replaced.replaces` must equal the slot) — this is what catches any deletion, net-zero
//     "delete k, insert k" included, without looking at a count at all;
//   * `inserted` lines sit only after the last original slot (appending new bytes at the end is
//     lossless; inserting between two original lines is not).
// `originalCount` closes the one case the per-line walk cannot see: originals removed after the
// last kept/replaced line, where no later line could expose the gap.
export function assertProvenancePatchable(lines, originalCount) {
  let slot = 0;
  let tail = false;
  for (const line of lines) {
    if (line.kind === "inserted") {
      tail = true;
      continue;
    }
    if (tail) throw notPatchable("the patch inserts a line in the middle of a document that is not valid UTF-8");
    if (line.kind !== "kept" && line.kind !== "replaced") throw notPatchable("the patch produced a line that cannot be mapped back to the document bytes");
    const index = line.kind === "kept" ? line.source : line.replaces;
    if (index !== slot) throw notPatchable("the patch removes or reorders a line of a document that is not valid UTF-8");
    slot += 1;
  }
  if (slot !== originalCount) throw notPatchable("the patch removes a line of a document that is not valid UTF-8");
}
