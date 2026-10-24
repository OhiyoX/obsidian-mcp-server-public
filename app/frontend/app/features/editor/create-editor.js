import { defaultKeymap, history, historyKeymap, indentWithTab, undo } from "@codemirror/commands";
import { defaultHighlightStyle, foldKeymap, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { Compartment, EditorSelection, EditorState, Prec, Transaction } from "@codemirror/state";
import { drawSelection, EditorView, keymap } from "@codemirror/view";
import { createLiveBlockPreview, liveMetaField, setLiveDocumentContext } from "./live-preview.js";
import { attachAssetDrop } from "./asset-drop-wiring.js";
import { cursorAfterFrontmatter, extractHeadings, simpleHash } from "./markdown-model.js";
import { computeTextChanges } from "./text-changes.js";
import { isLiveSurface, normalizeSurfaceMode } from "../document/surface-mode.js";
import { newlineInLive } from "./extensions/commands.js";
import { snapCaretToDevicePixels } from "./extensions/caret.js";
import { highlightedColourClass } from "./extensions/match-decorations.js";
import { decorated, highlightTrimEnd, highlightTrimStart, locateHighlightSpans } from "./extensions/match-decorations.js";
import { findInlineTags } from "../document/inline-tag-lexicon.js";
import { leavePropertiesWidget, surfaceModeExtensions } from "./extensions/surface.js";
import { obsidianHighlight, obsidianTheme } from "./extensions/theme.js";
import { liveCodeLanguageForFence } from "./extensions/code-languages.js";

function clampSelection(selection, length) {
  const anchor = Math.max(0, Math.min(selection.main.anchor, length));
  const head = Math.max(0, Math.min(selection.main.head, length));
  return EditorSelection.range(anchor, head);
}

// #484: the Live tag scan must agree with Reading's `obsidianTags` on what is a tag, so it calls
// the shared lexer (features/document/inline-tag-lexicon.js) instead of keeping its own pattern.
// Two syntax facts the lexeme alone cannot express, both taken from the Lezer tree:
//   - a link/image destination is literal text, because markdown-it's `link` rule consumes
//     `[a](#sec)` before the tag rule ever sees the `#`;
//   - a block marker that is glued to the tag (`>#tag`) still starts a block's inline content,
//     which is where markdown-it's `state.pos === 0` begins.
// Exported (not just local) so `test/inline-tag-lexicon-shared.test.js` feeds the *shipped*
// options into the same scan instead of re-declaring them.
export const LIVE_TAG_DECORATION = {
  className: "cm-obsidian-tag cm-hashtag cm-meta",
  excludedNodes: new Set(["URL", "LinkTitle", "Autolink"]),
  boundaryNodes: ["QuoteMark", "ListMark"],
};

// The CSRF token lives in the document head (see `core/app.js`). Read it lazily so a re-rendered
// page cannot leave the drop uploads holding a stale token.
function csrfToken() {
  if (typeof document === "undefined") return "";
  return document.querySelector('meta[name="csrf-token"]')?.content || "";
}

export function createObsidianEditor(parent, onChange) {
  const mode = new Compartment();
  const historyComp = new Compartment();
  // Per-editor table measurement context. The holder object is stable across
  // state reconfigurations; its `view` is set as soon as the EditorView exists.
  // Each editor owns its own holder, so table measurement is never shared.
  const tableMeasurementContext = { view: null };
  let sourcePath = "";
  let vaultId = "";
  let documentContext = null;
  let envVersion = "";
  let assetRevisions = {};
  let suppressChange = false;
  let currentMode = "raw";
  let contextRefreshQueued = false;
  let destroyed = false;

  const blockPreview = createLiveBlockPreview(() => ({
    sourcePath,
    vaultId,
    documentContext,
    envVersion,
    assetRevisions,
  }));

  function prepareContextLocal(text = view.state.doc.toString()) {
    const prepare = window.prepareObsidianDocumentContext;
    if (typeof prepare === "function") {
      const next = prepare(text, { sourcePath, vaultId, assetRevisions });
      const nextVersion = next?.envVersion || simpleHash(`${vaultId}\0${sourcePath}\0`);
      return { documentContext: next, envVersion: nextVersion };
    }
    return { documentContext: null, envVersion: simpleHash(`${vaultId}\0${sourcePath}\0`) };
  }

  function applyPreparedContext(prepared, { sync = true } = {}) {
    documentContext = prepared.documentContext;
    envVersion = prepared.envVersion;
    if (sync && !destroyed) blockPreview.syncContext(view);
  }

  function refreshDocumentContext({ force = false } = {}) {
    const prepared = prepareContextLocal();
    if (!force && prepared.envVersion === envVersion && documentContext) {
      // Definitions unchanged 鈥?do not dispatch (avoids rebuilding every widget DOM).
      return false;
    }
    applyPreparedContext(prepared, { sync: true });
    return true;
  }

  function queueDocumentContextRefresh() {
    if (contextRefreshQueued || destroyed || !isLiveSurface(currentMode)) return;
    contextRefreshQueued = true;
    queueMicrotask(() => {
      contextRefreshQueued = false;
      if (destroyed || !isLiveSurface(currentMode)) return;
      refreshDocumentContext();
    });
  }

  function buildExtensions(modeValue) {
    return [
      markdown({ extensions: GFM, codeLanguages: liveCodeLanguageForFence }),
      historyComp.of(history()),
      drawSelection({ drawRangeCursor: false }),
      snapCaretToDevicePixels,
      liveMetaField,
      mode.of(surfaceModeExtensions(modeValue, blockPreview, tableMeasurementContext)),
      Prec.high(keymap.of([
        { key: "Enter", run: newlineInLive },
        { key: "Shift-Enter", run: newlineInLive },
      ])),
      keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      syntaxHighlighting(obsidianHighlight),
      obsidianTheme,
      EditorView.lineWrapping,
      // Obsidian requires at least one non-numeric tag character. Keep issue
      // references such as #7 as ordinary body text instead of tag pills.
      decorated(findInlineTags, LIVE_TAG_DECORATION.className, LIVE_TAG_DECORATION),
      // Keep == source chrome outside the semantic paint box. Live Preview
      // may replace the markers and RAW may show them, but the highlight
      // background/padding always belongs to the visible content only.
      // locateHighlightSpans is the same rule the idle hide path uses: the
      // whole `=` run on each side is the delimiter (`===a===` paints `a`).
      // `====a====` is that rule with no owner screenshot (鎺ㄥ緱椤癸紝寰呯湡鍊?.
      decorated(locateHighlightSpans, "cm-obsidian-highlight cm-highlight", {
        trimStart: highlightTrimStart,
        trimEnd: highlightTrimEnd,
        // 1.14 coloured highlights: the class carries the colour, the same way
        // desktop's Live Preview adds `cm-highlight-<colour>` next to
        // `cm-highlight` and the stylesheet re-points `--highlight-background`.
        classFor: highlightedColourClass,
      }),
      decorated(/%%[^%\n]+%%/g, "cm-obsidian-comment cm-comment"),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !suppressChange) {
          onChange?.(update.state.doc.toString());
          queueDocumentContextRefresh();
        }
      }),
    ];
  }

  const view = new EditorView({
    state: EditorState.create({
      doc: "",
      extensions: buildExtensions("raw"),
    }),
    parent,
  });
  // The height map is built before the mounted widget's toDOM runs, so the
  // table extension reads the owning view from this context holder. Table
  // models capture the holder reference, not the view, so no state rebuild is
  // needed to attach measurement.
  tableMeasurementContext.view = view;

  // U30: image drop upload (RAW and Live). The insertion is one CodeMirror transaction, so a
  // single undo removes the reference only; the uploaded file stays in the Vault.
  const detachAssetDrop = attachAssetDrop(view, {
    getSourcePath: () => sourcePath,
    getCsrfToken: csrfToken,
    onInserted: () => {
      refreshDocumentContext({ force: true });
      blockPreview.refresh(view);
    },
  });

  return {
    getValue: () => view.state.doc.toString(),
    setValue(value, options = {}) {
      const text = String(value ?? "");
      const selection = options.preserveSelection
        ? clampSelection(view.state.selection, text.length)
        : EditorSelection.cursor(cursorAfterFrontmatter(text));
      const scrollTop = view.scrollDOM.scrollTop;
      suppressChange = Boolean(options.silent);
      try {
        if (options.resetHistory) {
          view.setState(EditorState.create({
            doc: text,
            selection,
            extensions: buildExtensions(currentMode),
          }));
          refreshDocumentContext({ force: true });
        } else {
          const annotations = [];
          if (options.silent) annotations.push(Transaction.addToHistory.of(false));
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: text },
            selection,
            annotations,
          });
          refreshDocumentContext({ force: true });
        }
      } finally {
        suppressChange = false;
      }
      if (options.preserveSelection) view.scrollDOM.scrollTop = scrollTop;
      if (isLiveSurface(currentMode)) leavePropertiesWidget(view);
    },
    /**
     * Apply external (clean SSE / conditional GET) text to the same document
     * identity. The old -> new delta is expressed as real changes, so the
     * existing selection, history and decorations map through the unchanged
     * islands instead of reusing stale absolute offsets. The transaction is
     * silent (no dirty callback) and is not recorded as a local undo step.
     */
    applyExternalText(value) {
      const text = String(value ?? "");
      const changes = computeTextChanges(view.state.doc.toString(), text);
      if (!changes.length) return false;
      suppressChange = true;
      try {
        view.dispatch({
          changes,
          annotations: Transaction.addToHistory.of(false),
        });
        refreshDocumentContext({ force: true });
      } finally {
        suppressChange = false;
      }
      if (isLiveSurface(currentMode)) leavePropertiesWidget(view);
      return true;
    },
    setMode(value) {
      const next = normalizeSurfaceMode(value);
      if (next === currentMode) return;
      const wasLive = isLiveSurface(currentMode);
      currentMode = next;
      if (isLiveSurface(currentMode)) {
        const prepared = prepareContextLocal();
        documentContext = prepared.documentContext;
        envVersion = prepared.envVersion;
        view.dispatch({
          effects: [
            mode.reconfigure(surfaceModeExtensions(currentMode, blockPreview, tableMeasurementContext)),
            setLiveDocumentContext.of({
              sourcePath,
              vaultId,
              documentContext,
              envVersion,
              assetRevisions: { ...assetRevisions },
            }),
          ],
        });
      } else {
        view.dispatch({
          effects: mode.reconfigure(surfaceModeExtensions(currentMode, blockPreview, tableMeasurementContext)),
        });
      }
      if (wasLive !== isLiveSurface(currentMode) || currentMode === "preview") {
        blockPreview.refresh(view);
      }
      if (isLiveSurface(currentMode)) leavePropertiesWidget(view);
    },
    setSourcePath(path, nextVaultId) {
      const nextPath = String(path || "");
      const nextVault = arguments.length > 1
        ? (nextVaultId != null ? String(nextVaultId) : "")
        : vaultId;
      if (nextPath !== sourcePath || nextVault !== vaultId) {
        assetRevisions = {};
      }
      sourcePath = nextPath;
      if (arguments.length > 1) vaultId = nextVault;
      refreshDocumentContext({ force: true });
      blockPreview.refresh(view);
    },
    getRenderContext() {
      const meta = view.state.field(liveMetaField, false);
      return {
        sourcePath,
        vaultId,
        assetRevisions: { ...(meta?.assetRevisions || assetRevisions) },
        documentContext,
      };
    },
    getViewportAnchor() {
      const scroll = view.scrollDOM;
      const rect = scroll.getBoundingClientRect();
      const pos = view.posAtCoords({ x: rect.left + 24, y: rect.top + 8 }, false);
      if (pos != null) return pos;
      return view.viewport.from;
    },
    getHeadings: () => extractHeadings(view.state),
    scrollToPosition(from) {
      const length = view.state.doc.length;
      const position = Math.max(0, Math.min(Number(from) || 0, length));
      view.dispatch({
        selection: EditorSelection.cursor(position),
        effects: EditorView.scrollIntoView(position, { y: "start", yMargin: 56 }),
      });
      view.focus();
      return true;
    },
    scrollToHeading(index) {
      const headings = extractHeadings(view.state);
      const heading = headings[index];
      if (!heading) return false;
      return this.scrollToPosition(heading.from);
    },
    refreshAssets(event) {
      const ok = blockPreview.refreshAssets(view, event);
      if (ok) {
        const meta = view.state.field(liveMetaField, false);
        if (meta?.assetRevisions) assetRevisions = { ...meta.assetRevisions };
      }
      return ok;
    },
    getSelection: () => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
    focus() {
      leavePropertiesWidget(view);
      view.focus();
      queueMicrotask(() => leavePropertiesWidget(view));
    },
    leavePropertiesCaret() {
      leavePropertiesWidget(view);
      queueMicrotask(() => leavePropertiesWidget(view));
    },
    destroy() {
      destroyed = true;
      detachAssetDrop();
      view.destroy();
    },
    /** @internal test helper */
    _view: view,
    _undo: () => undo(view),
  };
}

if (typeof window !== "undefined") window.createObsidianEditor = createObsidianEditor;

