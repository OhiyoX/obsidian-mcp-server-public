// Reading-surface copy-code button (#482, second slice).
//
// Desktop parity evidence (Obsidian 1.14.4, `<local-desktop-research>/extract/obsidian-asar-1.14.4`):
//   * the `app.js` post-processor walks `pre > code`, skips a `<pre>` that already
//     carries a `.copy-code-button` (so re-running is idempotent), creates the
//     button as a **direct child of that `<pre>`** (which is why the stylesheet's
//     `pre:not(:hover) > button.copy-code-button` child selector works and why the
//     `<pre>` is the positioning context), paints the lucide `copy` icon, and
//     copies the code text with exactly one trailing newline stripped;
//   * on click it flips the icon to `lucide-check`, paints it
//     `var(--text-success)` and restores both after one second;
//   * `app.css`@11836-11837 makes the `<pre>` the positioning context, @11854 hides
//     the button until the block is hovered and @11857-11874 paint it (values and
//     the `@media (hover: hover)` face) with `--background-modifier-hover`.
// Spec for this slice: `<local-desktop-research>/findings/code-block-affordances-spec.md` §一.
// The Desktop reading view has **no** language label, so nothing here may grow one
// — that is the Live half of #482 (`.code-block-flair`) and a separate lane.
//
// Deliberate additions over Desktop, all three required by the lane brief:
//   * `type="button"` plus `aria-label`/`title`, so the affordance is reachable
//     and announced instead of being an unlabelled icon;
//   * keyboard reachability: the `<pre>` is made a tab stop, because Desktop's
//     `display:none`-until-hover rule leaves the button unfocusable (spec §一 asks
//     for it and Desktop itself cannot provide it);
//   * a visible failure state. Desktop only awaits `navigator.clipboard` and would
//     fail silently where that API is unavailable (a non-secure origin, a denied
//     permission), so the legacy `document.execCommand("copy")` path is tried
//     before the button paints its error state. A copy that did not happen must
//     never look like one that did.
//
// The two glyphs are inline (`ui/copy-icon.js`), not sprite references: the sprite
// URL cannot be invalidated (see that module's header for the reproduced owner
// report), so the icon stays visible even when a browser still holds a sprite
// cached before this symbol existed.
//
// The copy primitive itself (clipboard, fallback, transient result) is shared with
// the Live flair — `features/document/code-copy.js`.
import {
  COPY_LABELS,
  copyCode,
  paintCopyState,
  stripTrailingNewline,
} from "../document/code-copy.js";

export const COPY_BUTTON_CLASS = "copy-code-button";
export const COPY_BUTTON_ATTR = "data-copy-code";
export { COPY_LABELS };

/** The `<code>` a `<pre>` owns directly — Desktop walks `pre > code`, not descendants. */
function directCodeChild(pre) {
  for (const child of pre?.childNodes ?? []) {
    if (child?.nodeType === 1 && String(child.tagName).toUpperCase() === "CODE") return child;
  }
  return null;
}

/** Idempotency check, expressed without `:scope` so a headless DOM can run it too. */
function directCopyButton(pre) {
  for (const child of pre?.childNodes ?? []) {
    if (child?.nodeType === 1 && child.classList?.contains(COPY_BUTTON_CLASS)) return child;
  }
  return null;
}

/** Desktop's `Nj()`: the code element's text minus exactly one trailing newline. */
export function codeBlockText(code) {
  return stripTrailingNewline(code?.textContent ?? "");
}

/** Copies one code block and paints the transient result on its button. */
export async function copyCodeBlock(button, code, options = {}) {
  return copyCode(button, code?.textContent ?? "", options);
}

/**
 * Desktop's reading-view post-processor: attach one copy button to every
 * `pre > code` under `root`, skipping blocks that already have one. Safe to call
 * after every render (the Reader re-renders on edits and on deferred content).
 * Returns how many buttons this call created.
 */
export function attachCopyCodeButtons(root, options = {}) {
  const doc = options.document ?? globalThis.document;
  if (!root || typeof root.querySelectorAll !== "function" || !doc) return 0;
  const nav = options.navigator ?? globalThis.navigator ?? doc.defaultView?.navigator ?? null;
  const schedule = options.setTimeout ?? globalThis.setTimeout;
  let attached = 0;
  for (const pre of root.querySelectorAll("pre")) {
    const code = directCodeChild(pre);
    if (!code || directCopyButton(pre)) continue;
    const button = doc.createElement("button");
    button.setAttribute("type", "button");
    button.setAttribute("class", COPY_BUTTON_CLASS);
    button.setAttribute(COPY_BUTTON_ATTR, "");
    paintCopyState(button, "idle");
    // Keyboard path: a `display:none` button cannot take focus, so the block
    // itself is the tab stop and `pre:focus-within` reveals the button (app.css).
    pre.setAttribute("tabindex", "0");
    button.addEventListener("click", (event) => {
      event?.preventDefault?.();
      void copyCodeBlock(button, code, { document: doc, navigator: nav, setTimeout: schedule });
    });
    pre.appendChild(button);
    attached += 1;
  }
  return attached;
}
