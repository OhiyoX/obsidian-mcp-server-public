import { iconHtml } from "../../ui/icons.js";
import { calloutIconHtml, calloutLabel } from "../document/callout-tokens.js";

/*
 * Reader callout DOM, rewritten to the canonical Obsidian shape.
 *
 * Desktop builds the callout in its markdown renderer (app.js @1362880):
 *
 *   e(t, "div", { className: "callout", dataCallout: n.type, dataCalloutIcon:
 *     n.icon, dataCalloutFold: n.fold, dataCalloutMetadata: n.data, style: r },
 *     [ e("div", "callout-title", [ e("div", "callout-icon"),
 *                                   e("div", "callout-title-inner", title) ]),
 *       e("div", "callout-content", content) ])
 *
 * and a Reader post-processor adds the folding chrome (app.js @1993241):
 *
 *   if (data-callout-fold === "+" || "-") {
 *     e.addClass("is-collapsible");
 *     s = n.createDiv("callout-fold");            // appended to .callout-title
 *     Ag(s, "lucide-chevron-down");
 *     if (fold === "-") a(true, false);           // is-collapsed on the callout
 *     s.classList.toggle("is-collapsed", collapsed)
 *   }
 *
 * #480: this used to run as one regex over the rendered HTML, which broke in two
 * ways that are both structural, not cosmetic — a title containing inline markup
 * (`<strong>`, `<a>`, `<code>`) never matched, and the non-greedy
 * `([\s\S]*?)</blockquote>` stopped at the *inner* `</blockquote>` so a nested
 * callout consumed its parent's closing tag. Doing the rewrite on the token
 * stream removes both: the marker is read from the first paragraph's inline text
 * (before it becomes HTML), titles keep their inline children, and nesting is
 * simply "the inner blockquote is another callout", which the same pass finds on
 * its own.
 *
 * Two Web-side notes, both recorded in the HANDOFF difference list:
 *   1. `.callout.is-collapsed > .callout-content` is hidden by CSS instead of
 *      Desktop's `Jf()` height animation, because the Web Reader is static;
 *   2. the callout metadata form `[!type|data]` is not parsed (v1) — the marker
 *      requires `]` right after the type, so such a block stays a plain quote,
 *      exactly as before this change.
 */

// Type matching is case-insensitive (`[!NOTE]` is a callout); the captured type
// is lowercased below, which is the normalization Desktop applies too
// (app.js @189747). Spaces are not part of the marker: `[!check circle]` stays a
// plain quote, the same as before this change.
const MARKER = /^\[!([a-z0-9_-]+)\]([+-])?[ \t]*/i;

function splitMarker(inline) {
  const children = Array.isArray(inline.children) ? inline.children : [];
  const first = children[0];
  if (!first || first.type !== "text") return null;
  const match = MARKER.exec(first.content);
  if (!match) return null;
  const rest = first.content.slice(match[0].length);
  const breakIndex = children.findIndex((child) => child.type === "softbreak" || child.type === "hardbreak");
  const head = breakIndex < 0 ? children : children.slice(0, breakIndex);
  // The marker itself is dropped; everything else on the title line keeps its
  // inline tokens (`**bold**`, `[[link]]`, `` `code` ``, `==highlight==`, #tag).
  const titleChildren = [{ ...first, content: rest }, ...head.slice(1)]
    .filter((child) => !(child.type === "text" && child.content === ""));
  const bodyChildren = breakIndex < 0 ? [] : children.slice(breakIndex + 1);
  return {
    type: match[1].toLowerCase(),
    fold: match[2] === "+" || match[2] === "-" ? match[2] : "",
    titleChildren,
    bodyChildren,
  };
}

function calloutOpenToken(open, plan) {
  const token = open;
  token.type = "callout_open";
  token.tag = "div";
  token.nesting = 1;
  token.callout = plan;
  return token;
}

function closeToken(token) {
  token.type = "callout_close";
  token.tag = "div";
  token.nesting = -1;
  token.callout = null;
  return token;
}

/**
 * Rewrite `> [!type] title` blockquotes into `callout_open`/`callout_close`
 * token pairs plus the canonical renderer rules. Runs after `inline` so the
 * marker can be read from parsed children rather than from HTML.
 */
export function configureCallouts(parser) {
  parser.core.ruler.after("inline", "obsidian_callouts", (state) => {
    const tokens = state.tokens;
    let index = 0;
    while (index < tokens.length) {
      if (tokens[index].type !== "blockquote_open") {
        index += 1;
        continue;
      }
      const paragraphOpen = tokens[index + 1];
      const inline = tokens[index + 2];
      const paragraphClose = tokens[index + 3];
      if (paragraphOpen?.type !== "paragraph_open" || inline?.type !== "inline" || paragraphClose?.type !== "paragraph_close") {
        index += 1;
        continue;
      }
      const plan = splitMarker(inline);
      if (!plan) {
        index += 1;
        continue;
      }
      // The matching close is the one at this blockquote's own depth, so a nested
      // callout can never steal it.
      let depth = 0;
      let closeIndex = -1;
      for (let scan = index; scan < tokens.length; scan += 1) {
        if (tokens[scan].type === "blockquote_open") depth += 1;
        else if (tokens[scan].type === "blockquote_close") {
          depth -= 1;
          if (depth === 0) { closeIndex = scan; break; }
        }
      }
      if (closeIndex < 0) {
        index += 1;
        continue;
      }

      calloutOpenToken(tokens[index], plan);
      closeToken(tokens[closeIndex]);
      if (plan.bodyChildren.length) {
        inline.children = plan.bodyChildren;
        inline.content = plan.bodyChildren.map((child) => child.content ?? "").join("");
        index += 1;
      } else {
        // No body: drop the marker paragraph entirely so `.callout-content` opens
        // straight onto the remaining blocks.
        tokens.splice(index + 1, 3);
        index += 1;
      }
    }
    return true;
  });

  parser.renderer.rules.callout_open = (tokens, index, options, env, self) => {
    const { type, fold, titleChildren } = tokens[index].callout;
    const label = titleChildren.length
      ? self.renderInline(titleChildren, options, env).trim()
      : calloutLabel(type);
    const collapsible = fold === "+" || fold === "-";
    const collapsed = fold === "-";
    const classes = `callout${collapsible ? " is-collapsible" : ""}${collapsed ? " is-collapsed" : ""}`;
    const foldAttribute = collapsible ? ` data-callout-fold="${fold}"` : "";
    const foldChrome = collapsible
      ? `<div class="callout-fold${collapsed ? " is-collapsed" : ""}">${iconHtml("chevron-down")}</div>`
      : "";
    return `<div class="${classes}" data-callout="${type}"${foldAttribute}>`
      + '<div class="callout-title">'
      + `<div class="callout-icon">${calloutIconHtml(type)}</div>`
      + `<div class="callout-title-inner">${label}</div>`
      + foldChrome
      + "</div>"
      + '<div class="callout-content">';
  };

  parser.renderer.rules.callout_close = () => "</div></div>";
}
