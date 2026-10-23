// Live Preview code-block flair (#482, third slice): the language label that sits
// in the top-right corner of a fenced code block.
//
// Desktop evidence (Obsidian 1.14.4 `app.js`, the `Z5` WidgetType and the
// `HyperMD-codeblock-end` branch of its code-block decoration pass):
//   * the flair is a **widget placed at the end of the opening fence line**
//     (`Decoration.widget({ widget: new Z5(display, code) }).range(openingLine.to)`);
//   * `Z5.toDOM` renders `createSpan({ cls: "code-block-flair", text: lang })` and,
//     when `lang` is empty, paints the lucide `copy` icon instead of a label;
//   * clicking it copies the fence body with exactly one trailing newline stripped
//     (`navigator.clipboard.writeText`) and raises a "copied" Notice — so the label
//     itself is the Live copy affordance, not decoration;
//   * the display name is CodeMirror 5's `findModeByName(info).name`, i.e. a table
//     by another name (`PowerShell`, `C++`, `Dockerfile`, …), falling back to the
//     raw info string;
//   * `app.css`@11943-11960 positions it (`absolute`, `right: 6px`, `top: 6px`,
//     `z-index: 1`) and paints the hover face with `--background-modifier-hover`;
//   * it is only created when the block is **not** being edited (`canRenderLang()`
//     covers mermaid/query/custom processors, which Web does not render yet, so
//     every fence takes this branch here).
// Spec: `<local-desktop-research>/findings/code-block-affordances-spec.md` §二,
// corrected by the two points above (`canRenderLang` coverage; an unknown or empty
// language paints the copy icon rather than nothing).
import { WidgetType } from "@codemirror/view";
import { codeLanguageKey, codeLanguageLabel } from "../../document/code-tokens.js";
import { COPY_LABELS, copyCode, setCopyGlyph } from "../../document/code-copy.js";

export const FLAIR_CLASS = "code-block-flair";
/** Added to the opening fence line so app.css/theme.js can host the flair. */
export const FLAIR_HOST_CLASS = "cm-live-code-flair-host";

/**
 * The display name a fence's info string maps to, or "" when the language is not
 * one of the shared keys (`codeLanguageKey`). "" is meaningful: Desktop paints the
 * copy icon for those fences.
 *
 * Accepts either a `SyntaxNode` or the `SyntaxNodeRef` the decoration pass hands
 * over (a Ref has no `getChild` of its own) — see `nodeTarget` below.
 */
export function codeBlockFlairLabel(state, node) {
  const info = nodeTarget(node)?.getChild?.("CodeInfo");
  if (!info) return "";
  return codeLanguageLabel(codeLanguageKey(state.sliceDoc(info.from, info.to)));
}

/**
 * A `SyntaxNode` from either shape. `syntaxTree(state).iterate()` yields a
 * `SyntaxNodeRef` (no `getChild`, no `nodeName`), and that is exactly what
 * `live-decorations.js` passes in — reading `node.getChild` straight off it
 * silently falls through to the fallback below (independent review F1: an
 * unclosed fence at EOF then copied an empty string while the flair said
 * "copied").
 */
function nodeTarget(node) {
  return node?.node ?? node ?? null;
}

/**
 * The fence body.
 *
 * Primary path: Lezer's `CodeText` child, which is the fence content without the
 * trailing newline Desktop's own slice keeps (copying strips exactly one, so both
 * agree) — and it also covers an **unclosed** fence, where Desktop's line
 * arithmetic drops the last line.
 *
 * Fallback (an empty fence has no `CodeText`): slice the lines between the fence
 * marks, and for an unclosed fence stop at the last line instead of the
 * second-to-last one.
 */
export function codeBlockBody(state, node) {
  const target = nodeTarget(node);
  if (!target) return "";
  const text = target.getChild?.("CodeText");
  if (text) return state.sliceDoc(text.from, text.to);
  const startLine = state.doc.lineAt(target.from).number;
  const endLine = state.doc.lineAt(Math.max(target.from, target.to - 1)).number;
  // A closed fence carries two `CodeMark` children (the same count
  // `live-decorations.js` uses); an unclosed one carries a single opening mark.
  let marks = 0;
  for (let child = target.firstChild; child; child = child.nextSibling) {
    if (child.name === "CodeMark") marks += 1;
  }
  const from = state.doc.line(Math.min(startLine + 1, state.doc.lines)).from;
  const lastBodyLine = marks >= 2 ? Math.max(endLine - 1, 1) : endLine;
  const to = state.doc.line(lastBodyLine).to;
  return to > from ? state.sliceDoc(from, to) : "";
}

/** The flair's own labels: a labelled flair says which language it copies. */
export function flairLabelText(label, state) {
  if (state !== "idle") return COPY_LABELS[state];
  return label ? `复制 ${label} 代码` : COPY_LABELS.idle;
}

/** Paints one state on a flair: label-aware announcement, colour, icon swap. */
export function paintFlair(host, state) {
  const label = host.getAttribute?.("data-flair-label") ?? "";
  host.classList?.remove("is-copied", "is-copy-failed");
  if (state === "copied") host.classList?.add("is-copied");
  if (state === "failed") host.classList?.add("is-copy-failed");
  host.setAttribute("data-copy-state", state);
  const text = flairLabelText(label, state);
  host.setAttribute("aria-label", text);
  host.setAttribute("title", text);
  // A labelled flair keeps its label; only the icon-only face swaps to the check.
  if (!label) setCopyGlyph(host, state === "copied" ? "check" : "copy");
}

/**
 * One fence's flair. `eq` compares the label and the body so CodeMirror rebuilds
 * the widget when either changes — the same contract Desktop's `Z5.eq` has.
 */
export class CodeBlockFlairWidget extends WidgetType {
  constructor(label, code, options = {}) {
    super();
    this.label = label;
    this.code = code;
    // Surface-supplied copy plumbing (document / navigator / setTimeout). Kept out
    // of `eq` on purpose: it is configuration, not widget content.
    this.options = options;
  }

  eq(other) {
    return other.label === this.label && other.code === this.code;
  }

  toDOM() {
    const host = document.createElement("span");
    host.setAttribute("class", FLAIR_CLASS);
    host.setAttribute("data-flair-label", this.label);
    host.setAttribute("role", "button");
    if (this.label) host.textContent = this.label;
    paintFlair(host, "idle");
    host.addEventListener("click", (event) => {
      event?.preventDefault?.();
      void copyCode(host, this.code, { ...this.options, paint: paintFlair });
    });
    return host;
  }
}
