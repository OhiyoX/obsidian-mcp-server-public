// U30 contract A4: the editor's image-drop wiring (RAW and Live surfaces).
//
// The listeners live on `view.dom` in the **capture** phase. That is not cosmetic: CodeMirror
// registers its own `drop` handler on `view.contentDOM`, and for a file drop it reads every
// file as *text* and inserts it (`@codemirror/view` `handlers.drop`). Capturing first and
// stopping propagation is what keeps a dropped PNG out of the document as mojibake, while a
// drag that carries no files is passed straight through to CodeMirror untouched.
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  assetEmbedText,
  assetFileNameHeader,
  cleanAssetName,
  createDragDepthCounter,
  isAllowedAssetName,
  resolveDropPosition,
  shouldHandleAssetDrop,
} from "./asset-drop.js";

export const ASSET_DROP_HIGHLIGHT_CLASS = "cm-asset-drop-active";
const PANEL_CLASS = "cm-asset-drop-status";
const ROW_CLASS = "cm-asset-drop-row";
const PROGRESS_CLASS = "cm-asset-drop-progress";
const CANCEL_CLASS = "cm-asset-drop-cancel";
const NOTICE_CLASS = "cm-asset-drop-notice";
const UNDO_NOTICE = "文件已上传，撤销仅移除引用。";
const AUTO_CLOSE_MS = 6000;

const PANEL_STYLE = {
  position: "absolute",
  right: "12px",
  bottom: "12px",
  zIndex: "6",
  display: "flex",
  flexDirection: "column",
  gap: "6px",
  padding: "8px 10px",
  minWidth: "240px",
  maxWidth: "340px",
  borderRadius: "6px",
  border: "1px solid var(--background-modifier-border, rgba(128,128,128,.35))",
  background: "var(--background-secondary, rgba(32,32,32,.95))",
  color: "var(--text-normal, #e6e6e6)",
  font: "12px/1.5 var(--font-interface, system-ui, sans-serif)",
  boxShadow: "0 2px 12px rgba(0,0,0,.28)",
};
const ROW_STYLE = { display: "grid", gridTemplateColumns: "1fr 64px auto", alignItems: "center", gap: "6px" };
const TRACK_STYLE = { height: "4px", borderRadius: "2px", background: "var(--background-modifier-border, rgba(128,128,128,.35))", overflow: "hidden" };
const BAR_STYLE = { display: "block", height: "100%", width: "0%", background: "var(--interactive-accent, #6c8ebf)", transition: "width .15s linear" };
const NAME_STYLE = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const CANCEL_STYLE = { border: "0", background: "transparent", color: "inherit", opacity: ".7", cursor: "pointer", font: "inherit", padding: "0 2px" };
const ERROR_STYLE = { color: "var(--text-error, #e06c75)", gridColumn: "1 / -1" };

function create(tag, style, text) {
  const element = document.createElement(tag);
  if (style) Object.assign(element.style, style);
  if (text != null) element.textContent = text;
  return element;
}

/** The coordinate hit, or the selection head when it is out of range or inside an atomic block. */
function dropPosition(view, event) {
  const state = view.state;
  let pos = null;
  try {
    pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
  } catch {
    pos = null;
  }
  return resolveDropPosition({
    pos,
    head: state.selection.main.head,
    docLength: state.doc.length,
    atomic: pos != null && insideAtomicRange(view, pos),
  });
}

/**
 * Live Preview renders some blocks as non-editable decorations and publishes them as
 * `EditorView.atomicRanges`; a caret cannot live inside one, so a drop there falls back.
 */
function insideAtomicRange(view, pos) {
  for (const source of view.state.facet(EditorView.atomicRanges)) {
    const ranges = source(view);
    if (!ranges) continue;
    let hit = false;
    ranges.between(pos, pos, () => { hit = true; });
    if (hit) return true;
  }
  return false;
}

export function attachAssetDrop(view, options = {}) {
  const {
    getSourcePath = () => "",
    getCsrfToken = () => "",
    upload = (input, signal) => fetch(input.url, { ...input.init, signal }),
  } = options;
  const depth = createDragDepthCounter();
  const host = view.dom;
  let panel = null;
  let notice = null;
  let noticeShown = false;
  let autoCloseTimer = null;
  let pending = 0;
  let detached = false;

  function setHighlight(active) {
    host.classList.toggle(ASSET_DROP_HIGHLIGHT_CLASS, active);
    host.style.outline = active ? "2px dashed var(--interactive-accent, #6c8ebf)" : "";
    host.style.outlineOffset = active ? "-2px" : "";
  }

  function ensurePanel() {
    if (panel || detached) return panel;
    panel = create("div", PANEL_STYLE);
    panel.className = PANEL_CLASS;
    panel.setAttribute("role", "status");
    panel.setAttribute("aria-live", "polite");
    host.appendChild(panel);
    return panel;
  }

  function scheduleAutoClose() {
    clearTimeout(autoCloseTimer);
    autoCloseTimer = setTimeout(() => {
      if (pending === 0) closePanel();
    }, AUTO_CLOSE_MS);
  }

  function closePanel() {
    clearTimeout(autoCloseTimer);
    autoCloseTimer = null;
    pending = 0;
    panel?.remove();
    panel = null;
    notice = null;
  }

  function showNotice(text) {
    if (!panel) return;
    if (!notice) {
      notice = create("div", { opacity: ".75" });
      notice.className = NOTICE_CLASS;
      panel.appendChild(notice);
    }
    notice.textContent = text;
  }

  /** One progress row per dropped file: name, progress track and its own cancel button. */
  function addRow(label) {
    const container = ensurePanel();
    const row = create("div", ROW_STYLE);
    row.className = ROW_CLASS;
    row.dataset.assetRow = label;
    const name = create("span", NAME_STYLE, label);
    const track = create("span", TRACK_STYLE);
    const bar = create("i", BAR_STYLE);
    track.className = PROGRESS_CLASS;
    track.appendChild(bar);
    const cancel = create("button", CANCEL_STYLE, "取消");
    cancel.className = CANCEL_CLASS;
    cancel.type = "button";
    row.append(name, track, cancel);
    container.appendChild(row);
    pending += 1;
    let abort = null;
    return {
      node: row,
      setCancel(handler) {
        abort = handler;
        cancel.hidden = false;
      },
      clearCancel() {
        abort = null;
        cancel.hidden = true;
      },
      /** `fetch` exposes no upload progress, so the bar is indeterminate until the 201 lands. */
      start() {
        bar.style.width = "35%";
        bar.style.opacity = ".6";
      },
      finish() {
        bar.style.width = "100%";
        bar.style.opacity = "1";
        row.classList.add("is-done");
        cancel.hidden = true;
        pending = Math.max(0, pending - 1);
        scheduleAutoClose();
      },
      fail(message) {
        row.classList.add("is-error");
        const detail = create("div", ERROR_STYLE, message);
        detail.className = "cm-asset-drop-error";
        row.appendChild(detail);
        cancel.hidden = true;
        pending = Math.max(0, pending - 1);
      },
      cancel() {
        abort?.();
      },
    };
  }

  async function uploadFile(file, row) {
    const controller = new AbortController();
    row.setCancel(() => controller.abort());
    row.start();
    const sourcePath = String(getSourcePath() || "");
    const url = `/api/web/v1/asset${sourcePath ? `?from=${encodeURIComponent(sourcePath)}` : ""}`;
    const init = {
      method: "POST",
      headers: {
        "X-CSRF-Token": String(getCsrfToken() || ""),
        "x-file-name": assetFileNameHeader(file.name),
        "Content-Type": file.type || "application/octet-stream",
      },
      body: file,
    };
    try {
      const response = await upload({ url, init }, controller.signal);
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.path) {
        row.fail(payload?.error || `上传失败（${response.status}）`);
        return null;
      }
      row.finish();
      return payload;
    } catch (error) {
      if (error?.name === "AbortError") {
        row.fail("已取消");
        return null;
      }
      row.fail("上传失败");
      return null;
    } finally {
      row.clearCancel();
    }
  }

  async function handleDrop(event) {
    if (!shouldHandleAssetDrop(event.dataTransfer?.types)) return;
    event.preventDefault();
    // Keep CodeMirror's own file-drop text reader from also seeing this event.
    event.stopPropagation();
    depth.reset();
    setHighlight(false);
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!files.length) return;
    const target = dropPosition(view, event);
    // Place the caret at the drop point before uploading, so the insertion point is visible
    // while the uploads run; the document is not touched until an upload succeeds.
    view.dispatch({ selection: EditorSelection.cursor(target) });
    const uploaded = [];
    for (const file of files) {
      const label = cleanAssetName(file.name)?.name || file.name;
      const row = addRow(label);
      if (!isAllowedAssetName(file.name)) {
        row.fail("不支持的图片类型");
        continue;
      }
      const payload = await uploadFile(file, row);
      if (payload) uploaded.push(payload);
    }
    if (!uploaded.length) return;
    const text = uploaded.map((item) => assetEmbedText(item.path)).join("\n");
    const from = Math.min(target, view.state.doc.length);
    view.dispatch({ changes: { from, insert: text }, selection: EditorSelection.cursor(from + text.length) });
    if (!noticeShown) {
      noticeShown = true;
      showNotice(UNDO_NOTICE);
    }
    options.onInserted?.(uploaded);
  }

  const onDragEnter = (event) => {
    if (!shouldHandleAssetDrop(event.dataTransfer?.types)) return;
    event.preventDefault();
    depth.enter();
    setHighlight(true);
  };
  const onDragOver = (event) => {
    if (!shouldHandleAssetDrop(event.dataTransfer?.types)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    setHighlight(true);
  };
  const onDragLeave = (event) => {
    if (!shouldHandleAssetDrop(event.dataTransfer?.types)) return;
    if (depth.leave() === 0) setHighlight(false);
  };
  const onDrop = (event) => {
    void handleDrop(event);
  };

  // Capture phase: the file-drag handlers must run before CodeMirror's contentDOM handlers.
  host.addEventListener("dragenter", onDragEnter, true);
  host.addEventListener("dragover", onDragOver, true);
  host.addEventListener("dragleave", onDragLeave, true);
  host.addEventListener("drop", onDrop, true);

  return function detachAssetDrop() {
    detached = true;
    host.removeEventListener("dragenter", onDragEnter, true);
    host.removeEventListener("dragover", onDragOver, true);
    host.removeEventListener("dragleave", onDragLeave, true);
    host.removeEventListener("drop", onDrop, true);
    setHighlight(false);
    closePanel();
  };
}
