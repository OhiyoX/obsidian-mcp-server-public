// The shell paints before the editor bundle exists (issue #414, part C).
//
// `app.js` used to call `window.createObsidianEditor(...)` at module scope, which forced
// the 660 KB `editor.js` to be fetched, parsed and executed before the Explorer could list
// a single note. This facade keeps the exact `window.createObsidianEditor` contract for
// every existing caller while creating the real editor only when a document is opened or an
// editable surface (Live/RAW) asks for it. Until then it buffers the document the shell
// sets, so the reading surface can render from `getValue()` and the buffer is flushed into
// the editor once it materializes.
//
// Why opening a document also loads the editor bundle (rather than only Live/RAW): the
// reading surface owns no heading model or asset-revision context of its own. The outline is
// built from the editor's source-mapped headings by design (`features/context/outline.js`:
// "Outline built from the source/editor heading model, not from a hidden reader DOM"), and
// the reader resolves `![[image]]` revisions from `getRenderContext()`. Serving a note
// without that model would need a second markdown heading parser in the shell and would let
// Reader/Live heading identity diverge. The shell — not the note — is what must stay light.
//
// Behaviour of the deferred window (deliberate and covered by the browser gate):
// - `setSourcePath` / `setValue` / `applyExternalText` carry a pending document, so they
//   start the load and are replayed into the editor when it exists.
// - `setMode` never loads the editor by itself: `view-mode-controller.setMode` also runs for
//   the preview surface, so it only records the mode to apply on materialization.
// - `focus` / `leavePropertiesCaret` / `scrollTo*` / `getViewportAnchor` are editable-surface
//   operations, so they trigger the load and are replayed once the editor exists.
// - `getRenderContext` returns the buffered source identity (no asset revisions/definition
//   context) while unloaded; the full-document reader only consumes sourcePath/vaultId, and
//   `onReady` re-renders the reader once the real context exists.
// - `refreshAssets` reports `true` while unloaded: without the editor cache the shell cannot
//   classify an asset hit, and the Vault event is already scoped to this Vault.
import { toast } from "../../ui/feedback.js";

export function createDeferredEditor(host, onChange, onReady = null) {
  const queued = [];
  let editor = null;
  let loading = null;
  let reported = false;
  let mode = null;
  let pendingDocument = null;
  let pendingSource = null;

  function materialize() {
    if (loading) return loading;
    const assets = window.__obsidianWebAssets;
    if (typeof assets?.ensureEditor !== "function") return Promise.resolve(null);
    loading = assets.ensureEditor().then(() => {
      editor = window.createObsidianEditor(host, onChange);
      if (pendingSource) editor.setSourcePath?.(pendingSource.path, pendingSource.vaultId);
      if (pendingDocument) editor.setValue(pendingDocument.content, pendingDocument.options);
      if (mode) editor.setMode(mode);
      onReady?.(editor);
      for (const replay of queued.splice(0)) replay(editor);
      return editor;
    }, (error) => {
      // The loader memoizes a failed bundle, so this reports once per page; refreshing the
      // page is the retry path (same contract as the old boot-time failure panel).
      if (!reported) {
        reported = true;
        console.error("Obsidian Web editor failed to initialize", error);
        toast("编辑器资源加载失败，请刷新页面重试。", true);
      }
      return null;
    });
    return loading;
  }

  // Editable-surface operation: run now, or replay right after materialization.
  function defer(replay) {
    if (editor) replay(editor);
    else {
      queued.push(replay);
      materialize();
    }
  }

  return {
    ensure: materialize,
    getValue: () => (editor ? editor.getValue() : pendingDocument?.content ?? ""),
    getSelection: () => (editor ? editor.getSelection() : ""),
    getHeadings: () => (editor ? editor.getHeadings() : []),
    getRenderContext: () => (editor
      ? editor.getRenderContext()
      : (pendingSource ? { sourcePath: pendingSource.path, vaultId: pendingSource.vaultId } : null)),
    getViewportAnchor: () => {
      if (editor) return editor.getViewportAnchor();
      materialize();
      return null;
    },
    setSourcePath(path, vaultId) {
      pendingSource = { path, vaultId };
      if (editor) editor.setSourcePath?.(path, vaultId);
      else materialize();
    },
    setValue(content, options) {
      pendingDocument = { content: String(content ?? ""), options };
      if (editor) editor.setValue(content, options);
      else materialize();
    },
    applyExternalText(value) {
      pendingDocument = { content: String(value ?? ""), options: { resetHistory: true, preserveSelection: false, silent: true } };
      if (editor) editor.applyExternalText(value);
      else materialize();
    },
    setMode(value) {
      mode = value;
      editor?.setMode?.(value);
    },
    focus: () => defer((target) => target.focus()),
    leavePropertiesCaret: () => defer((target) => target.leavePropertiesCaret()),
    // `bindDocumentNavigation` requires `=== true` to treat the scroll as handled; the
    // deferred replay lands on the same position once the editor exists.
    scrollToPosition: (from) => {
      if (!editor) {
        defer((target) => target.scrollToPosition?.(from));
        return true;
      }
      return editor.scrollToPosition(from) === true;
    },
    scrollToHeading: (index) => {
      if (!editor) {
        defer((target) => target.scrollToHeading?.(index));
        return true;
      }
      return editor.scrollToHeading(index) === true;
    },
    refreshAssets: (event) => (editor ? editor.refreshAssets?.(event) : true),
    destroy: () => editor?.destroy?.(),
  };
}
