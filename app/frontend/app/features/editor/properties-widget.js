import { WidgetType } from "@codemirror/view";
import { createPropertiesPanel } from "../document/properties-panel.js";
import { OBSIDIAN_NAVIGATE_EVENT, liveMetaField } from "./live-preview.js";
import { parseFrontmatterBlock, serializeFrontmatter } from "./frontmatter.js";

/**
 * CodeMirror adapter around the shared properties panel.
 * Editable when the document surface is writable; read-only in Reading mode.
 */
export class PropertiesWidget extends WidgetType {
  constructor(options) {
    super();
    this.source = options.source;
    this.sourceHash = options.sourceHash;
    this.blockFrom = options.blockFrom;
    this.blockTo = options.blockTo;
    this.panelEditable = options.editable !== false;
  }

  eq(other) {
    return other.sourceHash === this.sourceHash && other.panelEditable === this.panelEditable;
  }

  toDOM(view) {
    const parsed = parseFrontmatterBlock(this.source);
    const root = createPropertiesPanel({
      editable: this.panelEditable && !view.state.readOnly,
      data: parsed?.data || {},
      parseError: !parsed,
      // Reuse the editor navigation seam instead of a new route: bind-navigation listens
      // for this event on the editor host and sends detail.tag to the same search() the
      // inline #tags already use. The panel owns no query state.
      onSearchTag: (tag) => {
        const meta = view.state.field(liveMetaField, false);
        root.dispatchEvent(new CustomEvent(OBSIDIAN_NAVIGATE_EVENT, {
          bubbles: true,
          detail: { vaultId: meta?.vaultId ?? "", sourcePath: meta?.sourcePath ?? "", tag },
        }));
      },
      onChange: (nextData) => {
        const nextSource = serializeFrontmatter(nextData);
        const current = frontmatterWidgetSource(view.state.doc);
        const from = current?.from ?? this.blockFrom;
        const to = current?.to ?? Math.min(this.blockTo, view.state.doc.length);
        if (view.state.sliceDoc(from, to) === nextSource) return;
        view.dispatch({
          changes: { from, to, insert: nextSource },
        });
      },
    });
    root.classList.add("cm-live-properties");
    root.setAttribute("contenteditable", "false");
    root.addEventListener("mousedown", (event) => {
      if (event.target.closest("input, textarea, button, select, [contenteditable='true']")) return;
      event.preventDefault();
      event.stopPropagation();
    });
    return root;
  }

  // Keep the CM caret out of this block. Inputs still receive native events.
  ignoreEvent() {
    return true;
  }
}

export function frontmatterWidgetSource(doc) {
  const text = typeof doc === "string" ? doc : doc.toString();
  const match = text.match(/^---\r?\n[\s\S]*?^---(?:\r?\n|$)/m);
  if (!match || match.index !== 0) return null;
  return { source: match[0], from: 0, to: match[0].length };
}
