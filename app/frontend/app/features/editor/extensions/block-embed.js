import { WidgetType } from "@codemirror/view";

/**
 * Obsidian Desktop's embed *class face* for Live Preview, rendered in place.
 *
 * LP-08 freezes the Live contract: an `![[…]]` embed stays in-place wiki chrome
 * (`.cm-live-wiki-link`, never an atomic image/media widget), because Live's
 * block surfaces must not replace source with a foreign DOM subtree. This widget
 * therefore keeps the in-place chrome and only ADDS Desktop's embed container
 * classes (`app.js` `A3.initDOM` embed loader, `app.css:11841-11955`):
 *
 *   - image target  → `.internal-embed.image-embed`
 *   - audio/video   → `.internal-embed.file-embed`
 *   - note target   → `.internal-embed.markdown-embed.inline-embed`
 *
 * The classes let one Vault theme rule paint the Live embed like the Reader
 * embed. Resolving the asset URL and the note body stays with the Reader host:
 * the Reader already serves the revision-pinned image (`/api/web/v1/asset`) and
 * inlining a note body in Live would need a new server API, so Live keeps the
 * link label as visible content.
 */

const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]);
const AUDIO_EXTENSIONS = new Set(["flac", "m4a", "mp3", "oga", "ogg", "wav"]);
const VIDEO_EXTENSIONS = new Set(["m4v", "mov", "mp4", "ogv", "webm"]);

/** `[[Target#heading|Label]]` / `![[Target|Label]]` -> visible label. */
export function wikiLinkLabel(raw) {
  const embed = String(raw).startsWith("!");
  const inner = String(raw).slice(embed ? 3 : 2, -2);
  const pipe = inner.lastIndexOf("|");
  if (pipe >= 0) return inner.slice(pipe + 1).trim() || inner.slice(0, pipe);
  const hash = inner.indexOf("#");
  const path = hash >= 0 ? inner.slice(0, hash) : inner;
  const base = path.split("/").filter(Boolean).pop() || path;
  // Desktop joins the `#` segments with " > " when a link has no alias (asar app.js `dd`),
  // so `[[Note#Head]]` reads `Note > Head` here exactly as it does in Reading.
  return hash >= 0 ? base + inner.slice(hash).replace(/#/g, " > ") : base;
}

function embedTarget(raw) {
  return String(raw).slice(3, -2).split("|")[0].trim();
}

function embedExtension(target) {
  return target.split("#", 1)[0].split(".").pop()?.toLowerCase() || "";
}

/**
 * Desktop's canonical embed container faces for a target, in DOM order.
 * `internal-embed` is always the container class; the kind class follows it.
 */
export function embedSurfaceClasses(target) {
  const extension = embedExtension(target);
  if (IMAGE_EXTENSIONS.has(extension)) return ["internal-embed", "image-embed"];
  if (AUDIO_EXTENSIONS.has(extension) || VIDEO_EXTENSIONS.has(extension)) return ["internal-embed", "file-embed"];
  return ["internal-embed", "markdown-embed", "inline-embed"];
}

/**
 * In-place Live embed chrome: Desktop's embed container classes plus the wiki
 * link faces the frozen LP-08 contract requires.
 */
export class WikiEmbedWidget extends WidgetType {
  constructor(raw) {
    super();
    this.raw = raw;
    this.label = wikiLinkLabel(raw);
  }

  eq(other) {
    return other.raw === this.raw;
  }

  toDOM() {
    const root = document.createElement("span");
    root.className = [
      "cm-hmd-internal-link",
      "cm-obsidian-link",
      "cm-live-wiki-link",
      ...embedSurfaceClasses(embedTarget(this.raw)),
    ].join(" ");
    root.textContent = this.label;
    return root;
  }

  ignoreEvent() {
    return false;
  }
}

export function isWikiEmbed(raw) {
  return String(raw).startsWith("!");
}
