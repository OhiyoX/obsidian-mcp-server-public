export function normalizeTag(tag) {
  return String(tag || "").trim().replace(/^#+/, "").replace(/^\/+/, "").replace(/\s+/g, "-").toLowerCase();
}

export function maskCodeSpans(line) {
  const chars = line.split("");
  let i = 0;
  while (i < chars.length) {
    if (chars[i] !== "`") { i++; continue; }
    const start = i;
    while (i < chars.length && chars[i] === "`") i++;
    const openLen = i - start;
    let j = i;
    let found = false;
    while (j < chars.length) {
      if (chars[j] !== "`") { j++; continue; }
      const closeStart = j;
      while (j < chars.length && chars[j] === "`") j++;
      if (j - closeStart === openLen) {
        for (let k = start; k < j; k++) chars[k] = " ";
        i = j;
        found = true;
        break;
      }
    }
    if (!found) { /* opening backticks are literal, leave them */ }
  }
  return chars.join("");
}

export function updateFenceState(line, current) {
  // Notes synced from Windows arrive as CRLF, and splitLines() splits on "\n" without
  // stripping the "\r". JavaScript treats "\r" as a line terminator, so `.` never matched it
  // and the `(.*)$` opening-fence pattern failed outright: the fence was never opened and every
  // line inside it was parsed as prose (a `#` comment in a ```bash block became an H1 heading,
  // and tags/links inside fences leaked out). Normalize the line ending before matching.
  //
  // Note: this state machine is consumed by parseHeadings(), maskMarkdownCode() (links) and
  // inline-tag extraction. parseBlocks() does NOT consult it — fenced `^block-id` extraction is
  // a separate pre-existing behaviour, deliberately untouched here (issue #271).
  const text = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (current !== null) {
    const closeMatch = text.match(/^(\s*)(```+|~~~+)\s*$/);
    if (closeMatch) {
      const marker = closeMatch[2][0];
      const length = closeMatch[2].length;
      if (current.marker === marker && length >= current.length) return null;
    }
    return current;
  }
  const openMatch = text.match(/^(\s*)(```+|~~~+)(.*)$/);
  if (openMatch && openMatch[2].length >= 3) {
    const marker = openMatch[2][0];
    const info = openMatch[3];
    if (marker === "`" && info.includes("`")) return null;
    return { marker, length: openMatch[2].length };
  }
  return null;
}

export function isValidInlineTagBody(rawTag) {
  if (!rawTag) return false;
  if (rawTag.startsWith("/") || rawTag.endsWith("/")) return false;
  if (rawTag.includes("//")) return false;
  const normalized = normalizeTag(rawTag);
  if (!normalized || /^\d+$/.test(normalized)) return false;
  return true;
}
