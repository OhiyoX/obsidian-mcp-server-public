/*
 * Reader footnote DOM, rewritten to the canonical Obsidian shape.
 *
 * Desktop replaces markdown-it-footnote's output with its own transformer
 * (`app.js` @1359497 for the reference, @1360864-1361470 for the block):
 *
 *   sup.footnote-ref[data-footnote-id="fnref-1"]
 *     a.footnote-link[href="#fn-1"][data-footref="<identifier>"]  text "[1]"
 *   section.footnotes
 *     <hr>                                  (a plain thematicBreak — no class)
 *     <ol>
 *       li[data-footnote-id="fn-1"]  … a.footnote-backref.footnote-link
 *                                        [href="#fnref-1"] text "↩︎"
 *
 * Repeated references add Desktop's `-<occurrence>` suffix ("[1-2]"), and the
 * backref arrow is Desktop's `\u21a9\uFE0E` (app.js @1360945), which is also the
 * escape code markdown-it-footnote already uses so iOS keeps it a symbol.
 *
 * The classes below are the ones Desktop app.css 12178-12197 styles
 * (`.footnote-link`, `.footnotes`, `.footnote-ref`, `.footnote-backref`);
 * `footnotes-sep` / `footnotes-list` / `footnote-item` are markdown-it-footnote
 * inventions and are dropped so the Reader has a single truth source.
 */

function escapeAttribute(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function footnoteNumber(token) {
  const meta = token.meta || {};
  const base = String(Number(meta.id) + 1);
  return { base, labelled: meta.subId > 0 ? `${base}-${meta.subId}` : base };
}

export function configureFootnotes(md) {
  md.renderer.rules.footnote_ref = (tokens, index) => {
    const token = tokens[index];
    const { base, labelled } = footnoteNumber(token);
    const label = token.meta && token.meta.label ? token.meta.label : base;
    return `<sup class="footnote-ref" data-footnote-id="fnref-${labelled}">`
      + `<a class="footnote-link" href="#fn-${base}" data-footref="${escapeAttribute(label)}">[${labelled}]</a></sup>`;
  };
  // Desktop appends the block as `section.footnotes > (hr, ol)`.
  md.renderer.rules.footnote_block_open = () => '<section class="footnotes">\n<hr>\n<ol>\n';
  md.renderer.rules.footnote_open = (tokens, index) => {
    const { labelled } = footnoteNumber(tokens[index]);
    return `<li data-footnote-id="fn-${labelled}">`;
  };
  md.renderer.rules.footnote_anchor = (tokens, index) => {
    const { labelled } = footnoteNumber(tokens[index]);
    return ` <a class="footnote-backref footnote-link" href="#fnref-${labelled}">\u21a9\uFE0E</a>`;
  };
  md.renderer.rules.footnote_block_close = () => '</ol>\n</section>\n';
  return md;
}
