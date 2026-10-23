// Shared code-copy primitive for the two code-block affordances (#482): the
// Reading-surface hover button and the Live `.code-block-flair`. Desktop has one
// behaviour in two places — `app.js`'s reading post-processor and the `Z5` Live
// widget both strip exactly one trailing newline, write the code to the
// clipboard, and paint a transient result — so the Web keeps one implementation
// and lets each surface own only its DOM face.
//
// Deliberate additions over Desktop, both required by the lane briefs:
//   * the legacy `document.execCommand("copy")` path is tried when the Clipboard
//     API is missing or denies, because Desktop only awaits
//     `navigator.clipboard.writeText` and would fail silently;
//   * a visible failure state, so a copy that did not happen never looks like one
//     that did.
import { checkGlyph, copyGlyph } from "../../ui/copy-icon.js";

export const COPY_LABELS = Object.freeze({
  idle: "复制代码",
  copied: "已复制",
  failed: "复制失败，请手动选择代码",
});

export const COPIED_MS = 1000;
export const FAILED_MS = 1600;

// The most recent click owns the reset: a second click inside the first window
// must not be cut short by the earlier timer (independent review F5).
const pendingReset = new WeakMap();

/** Desktop's `Nj()`: the code text minus exactly one trailing newline. */
export function stripTrailingNewline(text) {
  const value = String(text ?? "");
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

/**
 * Swaps the element's icon, whether the face is an inline glyph (Reading button,
 * Live flair) or carries a label with no icon at all (a labelled Live flair keeps
 * its text and simply gains the copied/failed colour).
 */
export function setCopyGlyph(host, name) {
  const next = name === "check" ? checkGlyph() : copyGlyph();
  const current = host.querySelector?.("svg");
  if (current && typeof current.replaceWith === "function") current.replaceWith(next);
  else if (!host.querySelector?.("svg")) host.appendChild(next);
}

/** Paints one transient copy state on `host` (classes, label, icon). */
export function paintCopyState(host, state) {
  host.classList?.remove("is-copied", "is-copy-failed");
  if (state === "copied") host.classList?.add("is-copied");
  if (state === "failed") host.classList?.add("is-copy-failed");
  host.setAttribute("data-copy-state", state);
  host.setAttribute("aria-label", COPY_LABELS[state]);
  host.setAttribute("title", COPY_LABELS[state]);
  setCopyGlyph(host, state === "copied" ? "check" : "copy");
}

/** Pre-Clipboard-API fallback: a hidden selection plus `execCommand("copy")`. */
function legacyCopy(text, doc) {
  if (typeof doc?.execCommand !== "function") return false;
  const area = doc.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  doc.body?.appendChild?.(area);
  let copied = false;
  try {
    copied = doc.execCommand("copy") === true;
  } catch {
    copied = false;
  } finally {
    area.remove?.();
  }
  return copied;
}

async function writeClipboard(text, doc, nav) {
  const clipboard = nav?.clipboard;
  if (typeof clipboard?.writeText === "function") {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Denied or unavailable: fall through to the legacy path rather than
      // reporting a copy that did not happen.
    }
  }
  return legacyCopy(text, doc);
}

/**
 * Copies code text and paints the transient result on `host`.
 * Returns whether the text really reached a clipboard.
 */
export async function copyCode(host, text, options = {}) {
  const doc = options.document ?? globalThis.document;
  const nav = options.navigator ?? globalThis.navigator ?? doc?.defaultView?.navigator ?? null;
  const schedule = options.setTimeout ?? globalThis.setTimeout ?? ((fn) => fn());
  // The surface owns its own face: the Reading button and the Live flair paint
  // different DOM (an icon-only button vs a language label), so the caller may
  // pass its own painter and both share everything else.
  const paint = options.paint ?? paintCopyState;
  const copied = await writeClipboard(stripTrailingNewline(text), doc, nav);
  paint(host, copied ? "copied" : "failed");
  const token = {};
  pendingReset.set(host, token);
  schedule(() => {
    if (pendingReset.get(host) === token) paint(host, "idle");
  }, copied ? COPIED_MS : FAILED_MS);
  return copied;
}
