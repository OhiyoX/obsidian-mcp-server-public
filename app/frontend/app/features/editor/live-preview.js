import { syntaxTree } from "@codemirror/language";
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import {
  assetKey,
  canonicalPath,
  collectAssetPaths,
  eventMatchesAssets,
  simpleHash,
  frontmatterEndOffset,
} from "./markdown-model.js";
import { PropertiesWidget } from "./properties-widget.js";
import { interactionField, isInteractionFrozen } from "./interaction.js";
import { inlineTitleFromSourcePath } from "../document/inline-title.js";

export const refreshLiveBlocks = StateEffect.define();
export const setAssetRevisions = StateEffect.define();
export const setLiveDocumentContext = StateEffect.define();

/** Custom event name for modifier-click navigation from Live Preview widgets. */
export const OBSIDIAN_NAVIGATE_EVENT = "obsidian-navigate";

class InlineTitleWidget extends WidgetType {
  constructor(title) {
    super();
    this.title = title;
  }

  eq(other) {
    return other.title === this.title;
  }

  toDOM() {
    const root = document.createElement("div");
    root.className = "inline-title cm-live-inline-title";
    root.dataset.heading = this.title;
    root.textContent = this.title;
    root.setAttribute("contenteditable", "false");
    return root;
  }

  ignoreEvent() {
    return true;
  }
}

function buildTitleDecorations(state) {
  const meta = state.field(liveMetaField, false);
  const inlineTitle = inlineTitleFromSourcePath(meta?.sourcePath);
  if (!inlineTitle) return Decoration.none;
  return Decoration.set([
    Decoration.widget({
      widget: new InlineTitleWidget(inlineTitle),
      block: true,
      side: -1,
    }).range(0),
  ], true);
}

export function buildBlockDecorations(state) {
  const ranges = [];
  const frozen = isInteractionFrozen(state);
  // YAML stays a properties panel. Unclosed `---` is left as in-place source
  // so the closer can be typed; Markdown would otherwise turn it into an HR.
  const fmEnd = frontmatterEndOffset(state.doc)
    || (state.doc.line(1).text === "---" ? state.doc.length : 0);

  // Closed frontmatter is always the properties panel. Live never switches to
  // YAML source; caret inside the span is snapped out by leavePropertiesWidget.
  if (fmEnd > 0 && !frozen && frontmatterEndOffset(state.doc) > 0) {
    const source = state.sliceDoc(0, fmEnd);
    // Exclusive end: a block replace that includes the next line's from
    // swallows that line's LineView, so an H1 immediately after YAML
    // never gets cm-live-heading / fold alignment.
    ranges.push(Decoration.replace({
      widget: new PropertiesWidget({
        source,
        sourceHash: simpleHash(source),
        blockFrom: 0,
        blockTo: fmEnd,
        editable: !state.readOnly,
      }),
      block: true,
      inclusiveEnd: false,
    }).range(0, fmEnd));
  }

  return Decoration.set(ranges, true);
}

function collectDocumentDependencies(state, sourcePath) {
  return collectAssetPaths(state.doc.toString(), sourcePath);
}

export const liveMetaField = StateField.define({
  create() {
    return {
      sourcePath: "",
      vaultId: "",
      assetRevisions: {},
      documentContext: null,
      envVersion: "",
      dependencies: [],
    };
  },
  update(value, tr) {
    let next = value;
    for (const effect of tr.effects) {
      if (effect.is(setLiveDocumentContext)) {
        next = {
          ...next,
          ...effect.value,
          assetRevisions: effect.value.assetRevisions != null
            ? effect.value.assetRevisions
            : next.assetRevisions,
          dependencies: effect.value.dependencies || collectDocumentDependencies(tr.state, effect.value.sourcePath ?? next.sourcePath),
        };
      }
      if (effect.is(setAssetRevisions)) {
        next = {
          ...next,
          assetRevisions: { ...next.assetRevisions, ...effect.value },
        };
      }
    }
    if (tr.docChanged) {
      next = {
        ...next,
        dependencies: collectDocumentDependencies(tr.state, next.sourcePath),
      };
    }
    return next;
  },
});

export const liveTitleField = StateField.define({
  create(state) {
    return buildTitleDecorations(state);
  },
  update(decorations, tr) {
    const contextChanged = tr.effects.some((effect) => effect.is(setLiveDocumentContext));
    if (contextChanged || tr.docChanged || tr.reconfigured) return buildTitleDecorations(tr.state);
    return decorations;
  },
  // Title is view chrome, not source. Keep it outside atomicRanges so it cannot
  // change caret/selection semantics for Markdown content.
  provide: (field) => EditorView.decorations.from(field),
});

export const liveBlockField = StateField.define({
  create(state) {
    return buildBlockDecorations(state);
  },
  update(decorations, tr) {
    const forced = tr.effects.some((effect) => (
      effect.is(refreshLiveBlocks)
      || effect.is(setAssetRevisions)
      || effect.is(setLiveDocumentContext)
    ));
    const frozen = isInteractionFrozen(tr.state);
    const wasFrozen = isInteractionFrozen(tr.startState);
    const interactionTouched = tr.startState.field(interactionField, false) !== tr.state.field(interactionField, false);
    const treeChanged = syntaxTree(tr.state) !== syntaxTree(tr.startState);
    if (frozen) {
      return tr.docChanged ? decorations.map(tr.changes) : decorations;
    }
    if (forced || tr.docChanged || interactionTouched || treeChanged || (!frozen && wasFrozen) || tr.reconfigured) {
      return buildBlockDecorations(tr.state);
    }
    return decorations;
  },
  provide: (field) => [
    EditorView.decorations.from(field),
    EditorView.atomicRanges.from(field, (ranges) => () => ranges),
  ],
});

export function createLiveBlockPreview(getContext) {
  const extension = [liveMetaField, liveTitleField, liveBlockField];

  function contextSnapshot() {
    const ctx = typeof getContext === "function" ? getContext() : getContext;
    return {
      sourcePath: String(ctx?.sourcePath || ""),
      vaultId: ctx?.vaultId != null ? String(ctx.vaultId) : "",
      documentContext: ctx?.documentContext || null,
      envVersion: String(ctx?.envVersion || ""),
      assetRevisions: { ...(ctx?.assetRevisions || {}) },
    };
  }

  return {
    extension,
    blockExtension: [liveTitleField, liveBlockField],
    metaExtension: [liveMetaField],
    field: liveBlockField,
    metaField: liveMetaField,
    syncContext(view) {
      const snap = contextSnapshot();
      view.dispatch({
        effects: setLiveDocumentContext.of({
          ...snap,
          dependencies: collectDocumentDependencies(view.state, snap.sourcePath),
        }),
      });
    },
    refresh(view) {
      view.dispatch({ effects: refreshLiveBlocks.of(null) });
    },
    refreshAssets(view, event) {
      const meta = view.state.field(liveMetaField, false);
      if (!meta) return false;
      const deps = meta.dependencies?.length
        ? meta.dependencies
        : collectDocumentDependencies(view.state, meta.sourcePath);
      if (!eventMatchesAssets(event, deps, meta.vaultId)) return false;
      const path = canonicalPath(event.path);
      const key = assetKey(event.vaultId ?? meta.vaultId, path);
      const revision = event.revision != null ? String(event.revision) : String(Date.now());
      const revisions = { [key]: revision, [path]: revision };
      for (const dependency of deps) {
        if (dependency.split("/").at(-1).toLowerCase() === path.split("/").at(-1).toLowerCase()) {
          revisions[assetKey(meta.vaultId, dependency)] = String(event.id || revision);
        }
      }
      view.dispatch({
        effects: [
          setAssetRevisions.of(revisions),
          refreshLiveBlocks.of(null),
        ],
      });
      return true;
    },
  };
}
