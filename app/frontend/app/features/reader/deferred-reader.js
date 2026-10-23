// The reading surface must not block the shell (issue #414, part C): `reader.js` is no longer
// a shell `<script>`, so the first note render pulls it on demand and re-renders when it lands.
import { toast } from "../../ui/feedback.js";

let failed = false;

/**
 * Renders Markdown for the reading surface, loading `reader.js` when it is not there yet.
 *
 * @param {string} source raw Markdown
 * @param {object} options `renderObsidianMarkdown` context
 * @param {() => void} onReady called once the renderer exists, so the caller can re-render
 * @returns {string} the rendered HTML, or `""` while the renderer is still loading
 */
export function renderMarkdownOrDefer(source, options, onReady) {
  if (typeof window.renderObsidianMarkdown === "function") {
    return window.renderObsidianMarkdown(source, options);
  }
  const assets = window.__obsidianWebAssets;
  if (failed || typeof assets?.ensureReader !== "function") return "";
  assets.ensureReader().then(
    () => onReady?.(),
    (error) => {
      // One report per page: every later render would otherwise queue the same failure.
      failed = true;
      console.error("Obsidian Web reader failed to initialize", error);
      toast("阅读视图资源加载失败，请刷新页面重试。", true);
    },
  );
  return "";
}
