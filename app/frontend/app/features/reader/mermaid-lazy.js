// Reading-surface Mermaid (#482 third item): a ```mermaid fence becomes an SVG diagram.
// Desktop evidence (Obsidian 1.14.4 asar): its reading post-processor walks
// `code.language-mermaid`, measures the block's parent, renders into a hidden `div.mermaid` at
// that width via `mermaid.render(id, text, div)` and replaces the block with it (app.css@11875
// dark face, @12543 Live overflow, @3202 `--font-mermaid: var(--font-text)`); the library is
// itself lazily fetched and initialized by app.js.
//
// This module is the gate, and the only Mermaid code in the deferred reader bundle: it reaches
// for the chunk **only** when the document really has a mermaid fence, so a document without one
// never requests it. The chunk is a separate, shell-published asset that carries mermaid plus its
// styling, so neither the first screen nor the deferred bundles pay for the renderer.
const FENCE_SELECTOR = "code.language-mermaid";
const CHUNK_ATTR = "data-mermaid-src";
const ERROR_TEXT = "图表渲染失败，已保留源代码。";

/** The versioned chunk URL the shell published; "" when the shell predates this slice. */
export function mermaidChunkUrl(doc = globalThis.document) {
  return doc?.querySelector?.(`script[${CHUNK_ATTR}]`)?.getAttribute(CHUNK_ATTR) || "";
}

/** `pre > code.language-mermaid` blocks that are not already being dealt with. */
export function mermaidFences(root) {
  const fences = [];
  for (const code of root?.querySelectorAll?.(FENCE_SELECTOR) ?? []) {
    const pre = code.parentNode;
    if (pre?.tagName === "PRE" && !pre.hasAttribute("data-mermaid")) fences.push({ pre, code });
  }
  return fences;
}

const chunks = new Map();

// One fetch per URL per page: Desktop caches its `yE(...)` promise the same way, and a rejected
// load stays rejected instead of retrying on every re-render.
function loadChunk(url, importer) {
  if (!chunks.has(url)) chunks.set(url, Promise.resolve().then(() => importer(url)));
  return chunks.get(url);
}

/**
 * The Reading pass. Never rejects: a fence that cannot be rendered keeps its `<pre>` (and the
 * copy affordance that pass already attached) and gains a visible error line instead. The DOM
 * leg itself lives in the chunk, so this bundle only carries the gate.
 * Returns the tally the probes assert on.
 */
export async function attachMermaidBlocks(root, options = {}) {
  const doc = options.document ?? globalThis.document;
  const fences = mermaidFences(root);
  if (!fences.length) return { fences: 0, rendered: 0, failed: 0 };
  for (const { pre } of fences) pre.setAttribute("data-mermaid", "pending");
  const url = options.chunkUrl ?? mermaidChunkUrl(doc);
  let runtime = null;
  if (url) {
    try {
      runtime = await loadChunk(url, options.importer ?? ((href) => import(href)));
    } catch {
      runtime = null;
    }
  }
  let rendered = 0;
  for (const { pre, code } of fences) {
    try {
      if (!runtime) throw new Error("mermaid chunk unavailable");
      await runtime.renderFence(pre, code, doc);
      rendered += 1;
    } catch {
      pre.setAttribute("data-mermaid", "error");
      if (!pre.previousElementSibling?.classList?.contains("mermaid-error")) {
        const node = doc.createElement("p");
        node.setAttribute("class", "mermaid-error");
        node.setAttribute("role", "status");
        node.textContent = ERROR_TEXT;
        pre.before(node);
      }
    }
  }
  return { fences: fences.length, rendered, failed: fences.length - rendered };
}
