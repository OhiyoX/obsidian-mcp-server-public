// Obsidian 1.14 coloured highlights: `==🔴text==` paints the mark in that colour.
//
// Desktop's tokenizer reads the *first* code point of the highlight content, maps
// it through a fixed emoji table, strips it from the rendered text and hangs the
// colour on the `mark` node as `data-highlight="<colour>"`; the stylesheet then
// re-points `--highlight-background` at the matching variant. This module is the
// Shared table for both hosts (the Live Preview half lives in
// `editor/extensions/match-decorations.js`, which needs the same table).
//
// The table is transcribed from the 1.14.4 bundle, including the alternate
// square emoji: red 🔴/🟥, orange 🟠/🟧, yellow 🟡/🟨, green 🟢/🟩, blue 🔵/🟦,
// purple 🟣/🟪. Nothing else is a colour.

export const HIGHLIGHT_COLOR_EMOJI = new Map([
  ["\u{1F534}", "red"],
  ["\u{1F7E5}", "red"],
  ["\u{1F7E0}", "orange"],
  ["\u{1F7E7}", "orange"],
  ["\u{1F7E1}", "yellow"],
  ["\u{1F7E8}", "yellow"],
  ["\u{1F7E2}", "green"],
  ["\u{1F7E9}", "green"],
  ["\u{1F535}", "blue"],
  ["\u{1F7E6}", "blue"],
  ["\u{1F7E3}", "purple"],
  ["\u{1F7EA}", "purple"],
]);

/**
 * Colour of a highlight's *content* text, plus how many UTF-16 units the emoji
 * occupies (2 for every entry above — they are all astral). An unknown or absent
 * leading character yields `{ colour: "", length: 0 }`, which leaves the span as
 * a plain highlight, exactly like desktop.
 */
export function readHighlightColour(text) {
  const value = String(text ?? "");
  const codePoint = value.codePointAt(0);
  if (codePoint === undefined) return { colour: "", length: 0 };
  const symbol = String.fromCodePoint(codePoint);
  const colour = HIGHLIGHT_COLOR_EMOJI.get(symbol) ?? "";
  return { colour, length: colour ? symbol.length : 0 };
}

/** `"red"` for a coloured highlight's content text, `""` otherwise. */
export function highlightColourName(text) {
  return readHighlightColour(text).colour;
}

/**
 * The Live Preview class for a highlight's *source* text (`==🔴x==`), i.e.
 * `cm-highlight-<colour>`, or `""` when the span is uncoloured. Desktop uses the
 * same class names, so a theme's `span.cm-highlight-red` rule lands unchanged.
 */
export function highlightedColourClass(text) {
  const { colour } = readHighlightColour(text);
  return colour ? `cm-highlight-${colour}` : "";
}

/**
 * Strip the colour emoji from each `mark` and hang it on the open token.
 *
 * Runs after `inline` so the markdown-it-mark spans already exist. Only the first
 * child is inspected, and only a leading colour emoji is removed — an emoji
 * elsewhere in the text (or one that is not in the table) stays content.
 */
export function configureHighlightColours(parser) {
  parser.core.ruler.after("inline", "obsidian_highlight_colours", (state) => {
    for (const token of state.tokens) {
      if (token.type !== "inline" || !Array.isArray(token.children)) continue;
      const children = token.children;
      for (let index = 0; index < children.length; index += 1) {
        const open = children[index];
        if (open.type !== "mark_open") continue;
        const first = children[index + 1];
        if (!first || first.type !== "text") continue;
        const { colour, length } = readHighlightColour(first.content);
        if (!colour) continue;
        open.attrs = [...(open.attrs ?? []), ["data-highlight", colour]];
        first.content = first.content.slice(length);
      }
    }
    return true;
  });
}
