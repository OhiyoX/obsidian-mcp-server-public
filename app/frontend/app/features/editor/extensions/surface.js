import { codeFolding, foldEffect, foldable, foldedRanges, syntaxTree, unfoldEffect } from "@codemirror/language";
import { EditorSelection, EditorState, RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView, highlightActiveLineGutter, lineNumbers, ViewPlugin, WidgetType } from "@codemirror/view";
import { interactionField } from "../interaction.js";
import { cursorAfterFrontmatter, frontmatterEndOffset, selectionIsOnPropertiesWidget } from "../markdown-model.js";
import { normalizeSurfaceMode } from "../../document/surface-mode.js";
import { collapseNewlineClick, snapHiddenChromeCaret } from "./commands.js";
import { selectedLineGutter } from "./selection-gutter.js";
import { livePreview } from "./live-decorations.js";
import { calloutSurfaceField } from "./block-callout.js";
import { obsidianTableSurface } from "./table-surface.js";
import { decorated } from "./match-decorations.js";

function foldedRangeOn(state, from, to) {
  let found = null;
  foldedRanges(state).between(from, to, (start, end) => {
    if (!found || found.from > start) found = { from: start, to: end };
  });
  return found;
}

function headingLevelAt(state, from) {
  const line = state.doc.lineAt(from);
  let level = 0;
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter(node) {
      const match = /^ATXHeading([1-6])$/.exec(node.name);
      if (match) {
        level = Number(match[1]);
        return false;
      }
      return true;
    },
  });
  return level;
}

const FOLD_ICON_PATH = "m9 18 6-6-6-6";

function toggleFoldAt(view, from) {
  const line = view.state.doc.lineAt(from);
  const folded = foldedRangeOn(view.state, line.from, line.to);
  if (folded) {
    view.dispatch({ effects: unfoldEffect.of(folded) });
    return true;
  }
  const range = foldable(view.state, line.from, line.to);
  if (!range) return false;
  view.dispatch({ effects: foldEffect.of(range) });
  return true;
}

// Desktop 1.14.4 keeps the indicator *inline* in the heading line
// (`app.css@8259`: `.cm-fold-indicator { display: inline-block; position: relative }`
// + a zero-width-space `:before`), so the line's own geometry - heading level,
// before-space padding, block-widget offset - positions it. Nothing here may
// recompute line geometry by hand.
class FoldIndicator extends WidgetType {
  constructor(open, level, from) {
    super();
    this.open = open;
    this.level = level;
    this.from = from;
  }

  eq(other) {
    return other.open === this.open && other.level === this.level && other.from === this.from;
  }

  toDOM(view) {
    const wrapper = document.createElement("span");
    wrapper.className = `cm-fold-indicator${this.open ? " is-open" : " is-collapsed"} cm-fold-h${this.level}`;
    wrapper.dataset.foldFrom = String(this.from);
    const button = document.createElement("span");
    button.className = "collapse-indicator cm-fold-control";
    button.setAttribute("role", "button");
    button.setAttribute("tabindex", "0");
    button.setAttribute("aria-expanded", this.open ? "true" : "false");
    button.setAttribute("aria-label", this.open ? "collapse heading" : "expand heading");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "svg-icon cm-fold-indicator-icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", FOLD_ICON_PATH);
    svg.append(path);
    button.append(svg);
    wrapper.append(button);

    // The indicator sits in the content's inline-start padding, so a plain click
    // would otherwise move the caret into the heading. Keep the caret still and
    // hand the click straight to the keyboard-reachable control.
    const grab = (event) => {
      event.preventDefault();
      event.stopPropagation();
      button.focus({ preventScroll: true });
    };
    const activate = (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleFoldAt(view, this.from);
    };
    button.addEventListener("mousedown", grab);
    button.addEventListener("touchstart", grab, { passive: false });
    button.addEventListener("click", activate);
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") activate(event);
      else if (event.key === "Escape") button.blur();
    });
    return wrapper;
  }

  ignoreEvent() {
    return true;
  }
}

function headingFoldDecorations(view) {
  const builder = new RangeSetBuilder();
  const { doc } = view.state;
  const fmEnd = frontmatterEndOffset(doc);
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      pos = line.to + 1;
      // The heading is a whole document line here, so the block-widget offset
      // arithmetic the gutter needed (YAML properties widget sharing H1's
      // lineBlock) has no analogue: the widget joins the line's own inline flow.
      if (fmEnd && line.from < fmEnd) continue;
      const folded = foldedRangeOn(view.state, line.from, line.to);
      const canFold = folded || foldable(view.state, line.from, line.to);
      if (!canFold) continue;
      const level = headingLevelAt(view.state, line.from);
      if (!level) continue;
      builder.add(line.from, line.from, Decoration.widget({
        widget: new FoldIndicator(!folded, level, line.from),
        side: -1,
      }));
    }
  }
  return builder.finish();
}

const headingFoldIndicators = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = headingFoldDecorations(view);
  }

  update(update) {
    // Recompute on every update: a heading's foldability depends on the syntax
    // tree (parsed lazily) and on the fold state, and a view-range update is not
    // guaranteed for either. Only the rendered range is walked, so this is bounded
    // by the viewport, as the gutter's lineMarker was.
    this.decorations = headingFoldDecorations(update.view);
  }
}, {
  decorations: (plugin) => plugin.decorations,
});

const foldPlaceholder = (_view, onclick) => {
  const marker = document.createElement("span");
  marker.className = "cm-foldPlaceholder cm-obsidian-fold-placeholder";
  marker.textContent = "...";
  marker.setAttribute("aria-label", "folded code");
  marker.title = "unfold";
  marker.onclick = onclick;
  return marker;
};

const rawMode = [
  lineNumbers(),
  highlightActiveLineGutter(),
  selectedLineGutter,
  decorated(/!?\[\[[^\]\n]+\]\]/g, "cm-obsidian-link"),
];

export function leavePropertiesWidget(view) {
  if (view.state.readOnly) return false;
  if (!selectionIsOnPropertiesWidget(view.state.selection.ranges, view.state.doc)) return false;
  const pos = cursorAfterFrontmatter(view.state.doc);
  if (view.state.selection.main.empty && view.state.selection.main.from === pos) return false;
  view.dispatch({ selection: EditorSelection.cursor(pos) });
  return true;
}

const skipPropertiesCaret = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.queued = false;
    this.schedule(view);
  }
  update(update) {
    if (update.selectionSet || update.focusChanged || update.docChanged) this.schedule(update.view);
  }
  schedule(view) {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      leavePropertiesWidget(view);
    });
  }
});

const liveMode = (blockPreview, measurementContext) => [
  codeFolding({
    placeholderDOM: foldPlaceholder,
    placeholderText: "...",
  }),
  headingFoldIndicators,
  skipPropertiesCaret,
  snapHiddenChromeCaret,
  collapseNewlineClick,
  interactionField,
  ...obsidianTableSurface(measurementContext),
  livePreview,
  ...blockPreview.blockExtension,
  // Callout block surface sits after liveBlockField so it can read the Live
  // document context (sourcePath / vaultId / asset revisions) when building the
  // widget DOM.
  calloutSurfaceField,
];

export function surfaceModeExtensions(modeValue, blockPreview, measurementContext = null) {
  const mode = normalizeSurfaceMode(modeValue);
  if (mode === "raw") {
    return [
      EditorState.readOnly.of(false),
      EditorView.contentAttributes.of({ "data-editor-mode": "raw", "data-surface": "raw" }),
      ...rawMode,
    ];
  }
  if (mode === "preview") {
    return [
      EditorState.readOnly.of(true),
      EditorView.contentAttributes.of({ "data-editor-mode": "preview", "data-surface": "readonly-live" }),
      ...liveMode(blockPreview, measurementContext),
    ];
  }
  return [
    EditorState.readOnly.of(false),
    EditorView.contentAttributes.of({ "data-editor-mode": "live", "data-surface": "editable-live" }),
    ...liveMode(blockPreview, measurementContext),
  ];
}

