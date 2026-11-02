import { Decoration } from "@codemirror/view";

/**
 * Obsidian Desktop's Live Preview footnote surface.
 *
 * Desktop's Live host highlights footnote definitions through the CM5 markdown
 * mode faces declared in `obsidian.asar → app.css`: the definition line carries
 * `.HyperMD-footnote`, the `[^id]:` marker is `span.cm-hmd-footnote.cm-formatting`
 * and the definition body is `.cm-hmd-footnote-url-title`
 * (`app.css:12199-12229`). The Web host builds decoration ranges instead of a
 * CM5 mode, so the same canonical classes are emitted here.
 *
 * Inline `[^id]` references in body text are intentionally left as source: the
 * Reader renders them as `sup.footnote-ref > a.footnote-link` (see reader.js),
 * and the Live reference surface is a follow-up rather than a guessed class.
 */

const DEFINITION = /^ {0,3}\[\^[^\]\s]+\]:/;

function insideRanges(ranges, from, to) {
  return ranges.some((range) => from < range.to && to > range.from);
}

/**
 * Add the footnote-definition line surface for the visible viewport.
 * `codeRanges` are syntax nodes whose content must stay source (fences and
 * indented code), so a `[^x]:` example inside a code block is never dressed up.
 */
export function decorateFootnoteSurface(state, ranges, codeRanges, viewport) {
  const to = viewport.to;
  if (viewport.from >= to) return;
  const first = state.doc.lineAt(viewport.from).number;
  const last = state.doc.lineAt(to - 1).number;
  for (let number = first; number <= last; number += 1) {
    const line = state.doc.line(number);
    if (insideRanges(codeRanges, line.from, line.to)) continue;
    const marker = DEFINITION.exec(line.text);
    if (!marker) continue;
    ranges.push(Decoration.line({ class: "HyperMD-footnote" }).range(line.from));
    const markerTo = line.from + marker[0].length;
    ranges.push(Decoration.mark({ class: "cm-hmd-footnote cm-formatting" }).range(line.from, markerTo));
    if (line.to > markerTo) {
      ranges.push(Decoration.mark({ class: "cm-hmd-footnote-url-title" }).range(markerTo, line.to));
    }
    if (number === last) break;
  }
}
