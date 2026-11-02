import { StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { interactionField, isInteractionFrozen } from "../interaction.js";
import { liveMetaField, setLiveDocumentContext, refreshLiveBlocks } from "../live-preview.js";

/**
 * Obsidian Desktop renders a Live Preview callout as a block widget
 * (`div.cm-callout.cm-embed-block > div.markdown-preview-view.markdown-rendered >
 * div.callout…`, see `obsidian.asar → app.js` `L3`/`I3.initDOM`). The Web host
 * cannot run the Desktop widget, so this module produces the same canonical
 * surface: while the caret/selection is outside the callout the source is
 * replaced by a block widget carrying Desktop's callout DOM (rendered through
 * the shared Reader renderer so both hosts share ONE callout builder); while the
 * selection is inside, the source is revealed for editing, like every other
 * Live block surface.
 *
 * Fold interaction (click to collapse) is intentionally not wired yet; the
 * `is-collapsible` / `callout-fold` faces are still emitted so a Vault theme
 * paints the same shape.
 */

const CALLOUT_HEAD = /^ {0,3}>[ \t]?\[!([A-Za-z0-9_-]+)(?:\|([^\]\n]*))?\]([+-])?/;
const QUOTE_LINE = /^ {0,3}>/;
const FENCE_MARK = /^ {0,3}(`{3,}|~{3,})/;
// Same head prefix as CALLOUT_HEAD; `m` so `^` matches every line start.
const CALLOUT_MARKER = /^ {0,3}>[ \t]?\[!/m;
const NO_BLOCKS = [];
const blockCache = new WeakMap();

function selectionReveals(state, from, to) {
  return state.selection.ranges.some((range) => {
    const lo = Math.min(range.from, range.to);
    const hi = Math.max(range.from, range.to);
    if (lo === hi) return lo >= from && lo <= to;
    return lo < to && hi > from;
  });
}

/**
 * Bounded whole-document scan for callout blockquote ranges.
 *
 * CodeMirror's Markdown parse is viewport-incremental, so a block-replacing
 * widget must not depend on it (the same reason Table Surface parses the whole
 * document). The scanner therefore walks the text: a callout starts on a `>`
 * line whose first token is `[!type]` and extends over the contiguous `>`
 * lines. Fenced code is skipped so `> [!x]` inside a fence stays source.
 */
export function scanCalloutBlocks(doc) {
  const blocks = [];
  let fenced = false;
  let fenceChar = "";
  for (let number = 1; number <= doc.lines; number += 1) {
    const line = doc.line(number);
    const fence = FENCE_MARK.exec(line.text);
    if (fence) {
      const char = fence[1][0];
      if (!fenced) {
        fenced = true;
        fenceChar = char;
      } else if (char === fenceChar) {
        fenced = false;
      }
      continue;
    }
    if (fenced || !CALLOUT_HEAD.test(line.text)) continue;
    let last = number;
    for (let next = number + 1; next <= doc.lines && QUOTE_LINE.test(doc.line(next).text); next += 1) {
      last = next;
    }
    blocks.push({ from: line.from, to: doc.line(last).to });
    number = last;
  }
  return blocks;
}

/**
 * Cached whole-document callout scan.
 *
 * A callout head always contains the literal `> [!` (the `[ \t]?` between `>`
 * and `[` is optional), so a document without that marker cannot hold a callout.
 * The guard is one marker test over the flattened text instead of a per-line regex
 * walk over the whole document, and the result is memoised on the `Text` instance:
 * a CodeMirror `Text` is persistent/immutable, so object identity is a correct
 * cache key and a selection-only transaction (same document object) reuses the
 * previous scan instead of repeating it. LP-12 measures 10k-line dispatch latency,
 * where the per-update full scan used to eat the budget.
 */
export function calloutBlocks(doc) {
  const cached = blockCache.get(doc);
  if (cached) return cached;
  const marker = doc.toString();
  const blocks = CALLOUT_MARKER.test(marker) ? scanCalloutBlocks(doc) : NO_BLOCKS;
  blockCache.set(doc, blocks);
  return blocks;
}

/** Callout source -> Desktop's canonical callout faces (no DOM). */
export function calloutSurfaceModel(source) {
  const text = String(source ?? "");
  const firstLine = text.split("\n", 1)[0] || "";
  const match = CALLOUT_HEAD.exec(firstLine);
  const type = (match?.[1] || "note").toLowerCase();
  const metadata = (match?.[2] || "").trim();
  const fold = match?.[3] || "";
  const inlineTitle = firstLine.slice(match ? match[0].length : 0).trim();
  const body = text
    .split("\n")
    .slice(1)
    .map((line) => line.replace(QUOTE_LINE, "").replace(/^[ \t]?/, ""))
    .join("\n")
    .replace(/\s+$/u, "");
  return {
    type,
    metadata,
    fold,
    collapsible: fold === "+" || fold === "-",
    collapsed: fold === "-",
    title: inlineTitle || type[0].toUpperCase() + type.slice(1),
    body,
    source: text,
  };
}

function applyCalloutAttributes(element, model) {
  element.setAttribute("data-callout", model.type);
  if (model.metadata) element.setAttribute("data-callout-metadata", model.metadata);
  if (model.fold) element.setAttribute("data-callout-fold", model.fold);
}

/**
 * Fallback used when the shared Reader renderer is not loaded (for example a
 * bundle that never mounts reader.js). It emits the same canonical class and
 * attribute set with plain text content.
 */
export function buildCalloutFallbackElement(doc, model) {
  const callout = doc.createElement("aside");
  callout.className = "callout";
  callout.classList.add(`callout-${model.type}`);
  if (model.collapsible) callout.classList.add("is-collapsible");
  if (model.collapsed) callout.classList.add("is-collapsed");
  applyCalloutAttributes(callout, model);
  const title = doc.createElement("div");
  title.className = "callout-title";
  const icon = doc.createElement("div");
  icon.className = "callout-icon";
  const inner = doc.createElement("div");
  inner.className = "callout-title-inner";
  inner.textContent = model.title;
  title.append(icon, inner);
  if (model.collapsible) {
    const fold = doc.createElement("div");
    fold.className = `callout-fold${model.collapsed ? " is-collapsed" : ""}`;
    title.append(fold);
  }
  const content = doc.createElement("div");
  content.className = "callout-content";
  if (model.body) {
    const paragraph = doc.createElement("p");
    paragraph.textContent = model.body;
    content.append(paragraph);
  }
  callout.append(title, content);
  return callout;
}

class CalloutSurfaceWidget extends WidgetType {
  constructor(source, env) {
    super();
    this.source = source;
    this.env = env;
  }

  eq(other) {
    return other.source === this.source
      && other.env?.envVersion === this.env?.envVersion
      && other.env?.sourcePath === this.env?.sourcePath
      && other.env?.vaultId === this.env?.vaultId;
  }

  toDOM() {
    const root = document.createElement("div");
    root.className = "cm-callout cm-embed-block";
    const viewer = document.createElement("div");
    viewer.className = "markdown-preview-view markdown-rendered";
    const model = calloutSurfaceModel(this.source);
    let rendered = "";
    const render = globalThis.window?.renderObsidianMarkdown;
    if (typeof render === "function") {
      try {
        rendered = render(this.source, {
          fragment: true,
          blockId: `callout-${this.env?.envVersion || ""}`,
          sourcePath: this.env?.sourcePath || "",
          vaultId: this.env?.vaultId || "",
          documentContext: this.env?.documentContext || null,
        });
      } catch {
        rendered = "";
      }
    }
    if (rendered) viewer.innerHTML = rendered;
    else viewer.append(buildCalloutFallbackElement(document, model));
    root.append(viewer);
    return root;
  }

  ignoreEvent() {
    // Clicks must move the caret into the replaced range so the source is
    // revealed for editing (Desktop's click-to-edit behaviour).
    return false;
  }
}

function metaFor(state) {
  const meta = state.field(liveMetaField, false);
  return {
    sourcePath: meta?.sourcePath || "",
    vaultId: meta?.vaultId != null ? String(meta.vaultId) : "",
    documentContext: meta?.documentContext || null,
    envVersion: meta?.envVersion || "",
  };
}

export function buildCalloutDecorations(state) {
  const frozen = isInteractionFrozen(state);
  if (frozen) return Decoration.none;
  const env = metaFor(state);
  const ranges = [];
  for (const block of calloutBlocks(state.doc)) {
    if (!state.readOnly && selectionReveals(state, block.from, block.to)) continue;
    ranges.push(Decoration.replace({
      widget: new CalloutSurfaceWidget(state.sliceDoc(block.from, block.to), env),
      block: true,
    }).range(block.from, block.to));
  }
  return Decoration.set(ranges, true);
}

export const calloutSurfaceField = StateField.define({
  create(state) {
    return buildCalloutDecorations(state);
  },
  update(decorations, tr) {
    const frozen = isInteractionFrozen(tr.state);
    if (frozen) return tr.docChanged ? decorations.map(tr.changes) : decorations;
    const wasFrozen = isInteractionFrozen(tr.startState);
    const interactionTouched = tr.startState.field(interactionField, false) !== tr.state.field(interactionField, false);
    const contextChanged = tr.effects.some((effect) => (
      effect.is(setLiveDocumentContext) || effect.is(refreshLiveBlocks)
    ));
    if (tr.docChanged || tr.selectionSet || tr.reconfigured || interactionTouched || wasFrozen || contextChanged) {
      return buildCalloutDecorations(tr.state);
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});
