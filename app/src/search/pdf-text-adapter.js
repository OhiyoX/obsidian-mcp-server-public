// S7 (issue #667) — optional, page-cited PDF retrieval.
//
// Scope: only PDFs that already contain extractable text are ingested. Evidence is
// `{vaultId, path, revision, page, sourceType:"pdf", excerpt}` and `page` comes from the
// page tree (`/Root` -> `/Pages` -> `/Kids`), so it is the real page number.
//
// No dependency was added. `fflate` (already an app dependency) only inflates content
// streams; the PDF object reader, the page-tree walk, the content-stream text tokenizer and
// the ToUnicode CMap reader are local. Support boundary, stated instead of guessed:
//   - classic objects (`N 0 obj`); an object/xref *stream*-only file that hides its `/Root`
//     from a plain scan is refused as `corrupt`;
//   - content filters `FlateDecode` and none. Anything else (LZW, ASCII85, DCT, ...) is
//     `unsupported-filter`, never silent empty text;
//   - a composite font (Identity-H) without a usable ToUnicode map contributes no
//     characters. Nothing is invented for an unmapped code.
//   - scanned pages never produce text. OCR is opt-in and needs an injected backend; with
//     no backend the answer is `unavailable` / `ocr-unavailable`.
//
// Hard limits (documented numbers, never unbounded work):
//   maxBytes      8 MiB   file size, checked before parsing
//   maxPages      200     page-tree nodes, checked before any page is decoded
//   maxStreamBytes 16 MiB decoded content streams per document (decompression bombs)
//   maxMs         2000 ms wall clock per document
// The adapter only reads the bytes it is given; it never opens or writes a file.
//
// `shortcut:` notes mark the known shape limits of this reader.

import { Inflate, Unzlib } from "fflate";

export const PDF_LIMITS = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxPages: 200,
  maxStreamBytes: 16 * 1024 * 1024,
  maxMs: 2000,
});

const SOURCE_TYPE = "pdf";

function write(status, code, extra = {}) {
  return code === undefined ? { status, sourceType: SOURCE_TYPE, ...extra } : { status, sourceType: SOURCE_TYPE, code, ...extra };
}

function errorOf(code, reason) {
  return write("error", code, { reason });
}

function unavailableOf(code, reason, extra = {}) {
  return write("unavailable", code, { reason, ...extra });
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return null;
}

// ---------------------------------------------------------------------------
// Object reader. Latin-1 decoding keeps string indices equal to byte offsets.
// ---------------------------------------------------------------------------

// shortcut: object bodies are found by keyword scan, not by xref. A stream that
// contains the literal `endobj`/`endstream` would confuse it; a /Length integer is used
// first, which real generators always emit.
function readObjects(text) {
  const objects = new Map();
  const header = /(\d+)\s+(\d+)\s+obj\b/g;
  let match;
  while ((match = header.exec(text))) {
    const start = match.index + match[0].length;
    const streamAt = text.indexOf("stream", start);
    const endobjAt = text.indexOf("endobj", start);
    if (streamAt !== -1 && (endobjAt === -1 || streamAt < endobjAt)) {
      const dict = text.slice(start, streamAt);
      let dataStart = streamAt + "stream".length;
      if (text[dataStart] === "\r") dataStart += 1;
      if (text[dataStart] === "\n") dataStart += 1;
      const indirect = /\/Length\s+\d+\s+\d+\s+R/.test(dict);
      const direct = /\/Length\s+(\d+)/.exec(dict);
      const dataEnd = direct && !indirect ? dataStart + Number(direct[1]) : Math.max(dataStart, text.indexOf("endstream", dataStart));
      const after = text.indexOf("endstream", Math.min(dataEnd, text.length));
      objects.set(Number(match[1]), { dict, stream: { start: dataStart, end: dataEnd } });
      header.lastIndex = after === -1 ? text.length : after + "endstream".length;
      continue;
    }
    objects.set(Number(match[1]), { dict: text.slice(start, endobjAt === -1 ? text.length : endobjAt), stream: null });
    header.lastIndex = endobjAt === -1 ? text.length : endobjAt + "endobj".length;
  }
  return objects;
}

function balancedDict(text, from) {
  let depth = 0;
  for (let at = from; at < text.length - 1; at += 1) {
    const pair = text.slice(at, at + 2);
    if (pair === "<<") {
      depth += 1;
      at += 1;
    } else if (pair === ">>") {
      depth -= 1;
      at += 1;
      if (depth === 0) return text.slice(from, at + 1);
    }
  }
  return null;
}

function dictionaryOf(text, key) {
  const at = text.indexOf(`/${key}`);
  if (at === -1) return null;
  const rest = text.slice(at + key.length + 1);
  const indirect = /^\s+(\d+)\s+\d+\s+R/.exec(rest);
  if (indirect) return { ref: Number(indirect[1]) };
  const from = text.indexOf("<<", at);
  if (from === -1) return null;
  const dict = balancedDict(text, from);
  return dict ? { dict } : null;
}

const pageRefsIn = (dict) => [...dict.matchAll(/(\d+)\s+\d+\s+R/g)].map((match) => Number(match[1]));

// ---------------------------------------------------------------------------
// Page tree. Depth-first in `/Kids` order == real page numbers.
// ---------------------------------------------------------------------------

function walkPages(objects, rootDict, limits) {
  const pages = [];
  const seen = new Set();
  // `/Resources` is inheritable: a page without its own uses the nearest `/Pages` one.
  const visit = (dict, depth, inherited) => {
    if (!dict || depth > 64) return null;
    if (pages.length >= limits.maxPages) return "page-limit";
    const resources = dictionaryOf(dict, "Resources") ?? inherited;
    if (/\/Type\s*\/Pages\b/.test(dict)) {
      const kids = /\/Kids\s*\[([^\]]*)\]/.exec(dict);
      if (!kids) return null;
      for (const ref of pageRefsIn(kids[1])) {
        if (seen.has(ref)) continue;
        seen.add(ref);
        const problem = visit(objects.get(ref)?.dict, depth + 1, resources);
        if (problem) return problem;
      }
      return null;
    }
    if (/\/Type\s*\/Page\b/.test(dict)) {
      pages.push({ dict, resources });
      return null;
    }
    return null;
  };
  const pagesRoot = dictionaryOf(rootDict, "Pages");
  if (!pagesRoot) return null;
  const problem = visit(pagesRoot.dict ?? objects.get(pagesRoot.ref)?.dict, 0, null);
  return problem ? problem : pages;
}

// ---------------------------------------------------------------------------
// Streams and fonts.
// ---------------------------------------------------------------------------

// PDF `FlateDecode` is the zlib format (RFC 1950), not raw deflate, so the zlib reader is
// the spec-correct one; the raw reader is kept for generators that emit bare deflate.
function zlibWrapped(bytes) {
  return bytes.length >= 2 && (bytes[0] & 0x0f) === 8 && bytes[0] >> 4 <= 7 && (((bytes[0] << 8) | bytes[1]) % 31) === 0;
}

function inflateBounded(ctx, bytes) {
  const budget = ctx.limits.maxStreamBytes - ctx.decoded;
  const chunks = [];
  let total = 0;
  const Reader = zlibWrapped(bytes) ? Unzlib : Inflate;
  const inflate = new Reader((chunk) => {
    total += chunk.length;
    if (total > budget) {
      const error = new Error("stream-limit");
      error.code = "stream-limit";
      throw error;
    }
    chunks.push(Buffer.from(chunk));
  });
  inflate.push(bytes, true);
  return Buffer.concat(chunks);
}

function streamText(ctx, object) {
  if (!object?.stream) return null;
  const filter = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(object.dict);
  const filterText = filter?.[1] ?? "";
  if (filterText && !/\/FlateDecode/.test(filterText)) {
    const error = new Error("unsupported-filter");
    error.code = "unsupported-filter";
    throw error;
  }
  const raw = ctx.bytes.subarray(object.stream.start, object.stream.end);
  const decoded = filterText ? inflateBounded(ctx, raw) : raw;
  ctx.decoded += decoded.length;
  return decoded.toString("latin1");
}

const hexBytes = (hex) => {
  const clean = hex.replace(/\s+/g, "");
  const bytes = Buffer.alloc(Math.floor(clean.length / 2));
  for (let at = 0; at < bytes.length; at += 1) bytes[at] = Number.parseInt(clean.slice(at * 2, at * 2 + 2), 16);
  return bytes;
};

const hexToText = (hex) => {
  const clean = hex.replace(/\s+/g, "");
  let text = "";
  for (let at = 0; at + 4 <= clean.length; at += 4) text += String.fromCharCode(Number.parseInt(clean.slice(at, at + 4), 16));
  return text;
};

// ToUnicode: `bfchar` pairs and `bfrange` triples (incrementing target or target array).
function parseToUnicode(source) {
  const map = new Map();
  for (const block of source.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(Number.parseInt(pair[1], 16), hexToText(pair[2]));
    }
  }
  for (const block of source.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const triple of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g)) {
      const low = Number.parseInt(triple[1], 16);
      const high = Math.min(Number.parseInt(triple[2], 16), low + 0xffff);
      if (triple[4] !== undefined) {
        const targets = [...triple[4].matchAll(/<([0-9A-Fa-f]+)>/g)].map((match) => hexToText(match[1]));
        targets.forEach((target, offset) => {
          if (low + offset <= high) map.set(low + offset, target);
        });
        continue;
      }
      const base = hexToText(triple[3]);
      for (let code = low; code <= high; code += 1) {
        // shortcut: the increment rides the last UTF-16 unit only, which covers the
        // single-code-point ranges generators emit.
        map.set(code, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (code - low)));
      }
    }
  }
  return map;
}

function fontDecoder(ctx, ref, cache) {
  if (cache.has(ref)) return cache.get(ref);
  const object = ctx.objects.get(ref);
  let decoder = null;
  if (object) {
    const composite = /\/Subtype\s*\/Type0/.test(object.dict);
    const toUnicode = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(object.dict);
    let map = null;
    if (toUnicode) {
      const source = streamText(ctx, ctx.objects.get(Number(toUnicode[1])));
      if (source) map = parseToUnicode(source);
    }
    decoder = { codeWidth: composite ? 2 : 1, map };
  }
  cache.set(ref, decoder);
  return decoder;
}

// `/Contents 7 0 R` or `/Contents [7 0 R 8 0 R]`: a page may span several streams.
function contentRefs(dict) {
  const at = dict.indexOf("/Contents");
  if (at === -1) return [];
  const rest = dict.slice(at + "/Contents".length).trimStart();
  const indirect = /^(\d+)\s+\d+\s+R/.exec(rest);
  if (indirect) return [Number(indirect[1])];
  const array = /^\[([^\]]*)\]/.exec(rest);
  return array ? pageRefsIn(array[1]) : [];
}

function fontsFor(ctx, resources) {
  const fonts = new Map();
  const font = dictionaryOf(resources, "Font");
  const fontDict = font?.dict ?? ctx.objects.get(font?.ref)?.dict;
  if (!fontDict) return fonts;
  for (const entry of fontDict.matchAll(/\/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g)) fonts.set(entry[1], Number(entry[2]));
  return fonts;
}

// `shortcut:` a missing ToUnicode on a simple font decodes as Latin-1/WinAnsi, which is
// right for ASCII and approximate for the 0x80-0x9F block. A composite font without a map
// yields no characters at all: no guessed text.
function decodeBytes(bytes, decoder) {
  if (!decoder) return "";
  if (!decoder.map) return decoder.codeWidth === 1 ? bytes.toString("latin1") : "";
  let text = "";
  for (let at = 0; at + decoder.codeWidth <= bytes.length; at += decoder.codeWidth) {
    const code = decoder.codeWidth === 2 ? (bytes[at] << 8) | bytes[at + 1] : bytes[at];
    const mapped = decoder.map.get(code);
    if (mapped !== undefined) text += mapped;
  }
  return text;
}

function readLiteral(content, from) {
  let depth = 0;
  let text = "";
  for (let at = from; at < content.length; at += 1) {
    const char = content[at];
    if (char === "\\") {
      const next = content[at + 1];
      const escapes = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
      if (next === undefined) break;
      text += escapes[next] ?? next;
      at += 1;
      continue;
    }
    if (char === "(") {
      depth += 1;
      if (depth > 1) text += char;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return { bytes: Buffer.from(text, "latin1"), end: at + 1 };
      text += char;
      continue;
    }
    text += char;
  }
  return null;
}

function skipDictionary(content, from) {
  let depth = 0;
  for (let at = from; at < content.length - 1; at += 1) {
    const pair = content.slice(at, at + 2);
    if (pair === "<<") {
      depth += 1;
      at += 1;
    } else if (pair === ">>") {
      depth -= 1;
      at += 1;
      if (depth === 0) return at + 1;
    }
  }
  return content.length;
}

// Content-stream tokenizer: only text-showing operators contribute; everything else
// (graphics, images, annotations) is skipped.
// shortcut: a space comes from a space glyph, a `TJ` gap above 120 units, or a new `BT`
// block. Words positioned only by `Td`/`Tm` offsets can therefore run together; page
// numbers and the page's characters stay correct.
function contentText(content, fonts, cache, ctx) {
  const pieces = [];
  let pending = [];
  let fontRef = null;
  let lastName = "";
  let arrayDepth = 0;
  let index = 0;

  const flush = () => {
    if (!pending.length) return;
    const decoder = fontRef === null ? null : fontDecoder(ctx, fontRef, cache);
    let text = "";
    for (const part of pending) text += typeof part === "string" ? part : decodeBytes(part, decoder);
    if (text) pieces.push(text);
    pending = [];
  };

  while (index < content.length) {
    const char = content[index];
    if (char === "(") {
      const literal = readLiteral(content, index);
      if (!literal) break;
      pending.push(literal.bytes);
      index = literal.end;
      continue;
    }
    if (char === "<") {
      if (content[index + 1] === "<") {
        index = skipDictionary(content, index);
        continue;
      }
      const end = content.indexOf(">", index);
      if (end === -1) break;
      pending.push(hexBytes(content.slice(index + 1, end)));
      index = end + 1;
      continue;
    }
    if (char === "[") {
      arrayDepth += 1;
      index += 1;
      continue;
    }
    if (char === "]") {
      arrayDepth = Math.max(0, arrayDepth - 1);
      index += 1;
      continue;
    }
    if (char === "/") {
      const name = /^\/([^\s/<>\[\]()%{}]+)/.exec(content.slice(index));
      if (name) {
        lastName = name[1];
        index += name[0].length;
        continue;
      }
      index += 1;
      continue;
    }
    const number = /^[-+]?\d*\.?\d+/.exec(content.slice(index));
    if (number) {
      if (arrayDepth > 0 && Math.abs(Number(number[0])) > 120 && pending.length) pending.push(" ");
      index += number[0].length;
      continue;
    }
    const word = /^(?:[A-Za-z'"*]|BDC|EMC)+/.exec(content.slice(index));
    if (word) {
      const operator = word[0];
      index += operator.length;
      if (operator === "Tf") fontRef = fonts.get(lastName) ?? null;
      else if (operator === "Tj") flush();
      else if (operator === "TJ") flush();
      else if (operator === "'" || operator === '"') {
        pieces.push(" ");
        flush();
      } else if (operator === "BT") pieces.push(" ");
      else if (operator === "ET") flush();
      continue;
    }
    index += 1;
  }
  flush();
  return pieces.join("").replace(/[ \t\r\n]+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Page-scoped extraction.
// ---------------------------------------------------------------------------

function pageText(ctx, page, cache) {
  const { dict, resources } = page;
  const fonts = fontsFor(ctx, resources?.dict ?? ctx.objects.get(resources?.ref)?.dict ?? "");

  const refs = contentRefs(dict);
  let text = "";
  for (const ref of refs) {
    const source = streamText(ctx, ctx.objects.get(ref));
    if (source) text += `${text ? " " : ""}${contentText(source, fonts, cache, ctx)}`;
    if (Date.now() - ctx.started >= ctx.limits.maxMs) {
      const error = new Error("time-limit");
      error.code = "time-limit";
      throw error;
    }
  }
  return text.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Public extraction.
// ---------------------------------------------------------------------------

export function extractPdfText(bytes, options = {}) {
  const limits = { ...PDF_LIMITS, ...(options.limits || {}) };
  const started = Date.now();
  const data = toBuffer(bytes);
  if (!data) return errorOf("corrupt", "input must be a Buffer, Uint8Array or ArrayBuffer");
  if (data.length > limits.maxBytes) {
    return errorOf("over-limit", `document is ${data.length} bytes, the cap is ${limits.maxBytes}`);
  }
  if (options.ocr && typeof options.ocrBackend !== "function") {
    return unavailableOf("ocr-unavailable", "OCR was requested but no OCR backend is configured; the text is not guessed");
  }

  const text = data.toString("latin1");
  if (!text.slice(0, 1024).includes("%PDF-")) return errorOf("corrupt", "no %PDF header");
  // shortcut: `/Encrypt` is detected by its dictionary entry anywhere in the file.
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(text)) {
    return errorOf("encrypted", "the document is encrypted; encrypted text is not extracted");
  }
  const rootRef = /\/Root\s+(\d+)\s+\d+\s+R/.exec(text);
  if (!rootRef) return errorOf("corrupt", "no document catalog (/Root)");
  const objects = readObjects(text);
  const rootDict = objects.get(Number(rootRef[1]))?.dict;
  if (!rootDict) return errorOf("corrupt", "the document catalog is missing");

  const walk = walkPages(objects, rootDict, limits);
  if (walk === "page-limit") return errorOf("page-limit", `the document has more than ${limits.maxPages} pages`);
  if (!Array.isArray(walk) || !walk.length) return errorOf("corrupt", "no page tree with pages");

  const ctx = { bytes: data, objects, limits, started, decoded: 0 };
  const cache = new Map();
  const pages = [];
  const unreadablePages = [];
  try {
    walk.forEach((pageEntry, offset) => {
      if (Date.now() - started >= limits.maxMs) {
        const error = new Error("time-limit");
        error.code = "time-limit";
        throw error;
      }
      const page = offset + 1;
      let extracted = pageText(ctx, pageEntry, cache);
      if (!extracted && options.ocr) extracted = String(options.ocrBackend({ page, sourceType: SOURCE_TYPE }) ?? "").trim();
      if (extracted) pages.push({ page, text: extracted });
      else unreadablePages.push(page);
    });
  } catch (error) {
    if (error.code === "stream-limit") return errorOf("stream-limit", `decoded content streams exceed ${limits.maxStreamBytes} bytes`);
    if (error.code === "time-limit") return errorOf("time-limit", `extraction exceeded ${limits.maxMs} ms`);
    if (error.code === "unsupported-filter") return errorOf("unsupported-filter", "a content stream uses a filter this adapter cannot decode");
    return errorOf("corrupt", `the document could not be read: ${error.message}`);
  }

  if (unreadablePages.length) {
    return unavailableOf("no-extractable-text", "some pages carry no extractable text; scanning them needs an OCR backend", {
      pageCount: walk.length,
      unreadablePages,
      pages: [],
    });
  }
  return write("ok", undefined, { pageCount: walk.length, pages, ...(options.ocr ? { ocr: true } : {}) });
}

// ---------------------------------------------------------------------------
// Derived index: one per Vault, page-cited evidence, cleared on deletion.
// ---------------------------------------------------------------------------

// `shortcut:` a query matches as one case-insensitive substring, not as terms. This is
// evidence lookup for an already-ranked document, not a second search ranker.
function excerptFor(text, query, maxChars) {
  const needle = String(query ?? "").normalize("NFKC").toLowerCase();
  if (!needle) return null;
  const at = text.normalize("NFKC").toLowerCase().indexOf(needle);
  if (at === -1) return null;
  const start = Math.max(0, at - Math.floor(Math.max(0, maxChars - needle.length) / 2));
  return text.slice(start, start + maxChars).trim();
}

export function createPdfTextIndex({ vaultId, limits } = {}) {
  if (!vaultId) throw new TypeError("createPdfTextIndex requires a vaultId");
  const entries = new Map();

  return {
    get vaultId() {
      return vaultId;
    },
    get size() {
      return entries.size;
    },
    paths() {
      return [...entries.keys()];
    },
    // `vaultId` defaults to this index's Vault; a foreign one is refused, never stored.
    ingest({ vaultId: from = vaultId, path: notePath, revision, bytes, ocr, ocrBackend } = {}) {
      if (from !== vaultId) return errorOf("cross-vault", `this index belongs to ${vaultId}, not ${from}`);
      const extraction = extractPdfText(bytes, { limits, ocr, ocrBackend });
      if (extraction.status !== "ok") return extraction;
      entries.set(notePath, { revision, pages: extraction.pages });
      return { ...extraction, path: notePath, revision };
    },
    search(query, { limit = 8, maxChars = 400 } = {}) {
      const citations = [];
      for (const [notePath, entry] of entries) {
        for (const page of entry.pages) {
          const excerpt = excerptFor(page.text, query, maxChars);
          if (!excerpt) continue;
          citations.push({ vaultId, path: notePath, revision: entry.revision, page: page.page, sourceType: SOURCE_TYPE, excerpt });
          if (citations.length >= limit) return citations;
        }
      }
      return citations;
    },
    remove({ path: notePath } = {}) {
      return entries.delete(notePath);
    },
  };
}
