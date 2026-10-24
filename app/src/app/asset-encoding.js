// Immutable-asset response layer for `/app/assets/*` (issue #414).
//
// Two measured defects are fixed here, both reproduced against a local instance
// before the change (see `U38/verify/00-before-fix-headers.txt`):
//   1. `securityHeaders` covers every `/app/*` path and set `Cache-Control:
//      no-store` *before* the static mount ran. Express `send` only writes the
//      mount's `immutable`/`max-age=1y` when the header is still unset, so the
//      immutable policy was silently replaced and every asset was re-downloaded
//      on every navigation even though its URL already carries `?v=<sha256>`;
//   2. nothing compressed the text assets: `Accept-Encoding: gzip` was ignored
//      and no `Vary` was sent.
//
// This handler owns the response for existing asset files. It is registered
// before the generic no-store middleware, and the `express.static` mount stays
// behind it so 404s, directory requests and unknown extensions keep exactly the
// old behaviour. Gzip output is cached in memory keyed by name + mtime + size:
// an edit or redeploy produces a new key, so there is no invalidation race and
// no unbounded growth (the cache is capped).

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

// Assets are content-addressed by `pages.js` (`/app/assets/<name>?v=<hash>`), so
// a one-year immutable policy cannot serve a stale file after a deployment.
export const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

// Only textual formats are compressed; already-compressed formats (woff/woff2,
// png/jpeg/webp/avif, ico) stay byte-identical instead of gaining a gzip frame.
const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=UTF-8"],
  [".html", "text/html; charset=UTF-8"],
  [".js", "application/javascript; charset=UTF-8"],
  [".json", "application/json; charset=UTF-8"],
  [".map", "application/json; charset=UTF-8"],
  [".mjs", "application/javascript; charset=UTF-8"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=UTF-8"],
  [".webmanifest", "application/manifest+json"],
]);
const COMPRESSIBLE_EXTENSIONS = new Set([".css", ".html", ".js", ".json", ".map", ".mjs", ".svg", ".txt", ".webmanifest"]);

// Below this size the gzip frame is not worth the extra bytes.
const MIN_GZIP_BYTES = 512;
const GZIP_LEVEL = 9;
const MAX_CACHE_ENTRIES = 64;

/** RFC 9110 `Accept-Encoding` negotiation for `gzip` only (no brotli dependency). */
export function acceptsGzip(header) {
  if (!header) return false;
  let wildcard = null;
  let explicit = null;
  for (const part of String(header).split(",")) {
    const [rawToken, ...params] = part.trim().split(";");
    const token = rawToken.trim().toLowerCase();
    if (token !== "gzip" && token !== "*") continue;
    let quality = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param);
      if (match) quality = Number(match[1]);
    }
    if (!Number.isFinite(quality)) quality = 0;
    if (token === "gzip") explicit = quality;
    else wildcard = quality;
  }
  // An explicit `gzip;q=0` wins over a later wildcard entry.
  return (explicit ?? wildcard ?? 0) > 0;
}

function extensionOf(relativePath) {
  return path.extname(relativePath).toLowerCase();
}

/**
 * @param {{ root: string, cache?: Map<string, object> }} options
 *   `root` is the absolute asset directory (with or without a trailing separator).
 * @returns {import("express").RequestHandler} GET/HEAD handler for `/app/assets/*`.
 */
export function createImmutableAssetHandler({ root, cache = new Map() } = {}) {
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;

  async function load(relative, absolute) {
    const info = await stat(absolute);
    if (!info.isFile()) return null;
    const key = `${relative}\u0000${info.mtimeMs}\u0000${info.size}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const body = await readFile(absolute);
    const digest = createHash("sha256").update(body).digest("hex").slice(0, 32);
    const extension = extensionOf(relative);
    const entry = {
      body,
      gzip: null,
      compressible: COMPRESSIBLE_EXTENSIONS.has(extension) && body.length >= MIN_GZIP_BYTES,
      // The content-coding is part of the selected representation, so the gzip
      // variant gets its own (derived, still content-addressed) entity tag.
      etag: `"${digest}"`,
      gzipEtag: `"${digest}-gzip"`,
      lastModified: new Date(info.mtimeMs).toUTCString(),
      contentType: CONTENT_TYPES.get(extension) || null,
    };
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(key, entry);
    return entry;
  }

  return async function immutableAssetHandler(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    // Ranges keep the historical identity path (and its Accept-Ranges support).
    if (req.headers.range) return next();
    let relative;
    try {
      relative = decodeURIComponent(req.path || "");
    } catch {
      return next();
    }
    if (!relative.startsWith("/") || relative.includes("\0")) return next();
    // `path.join` normalises `..`, so the prefix check rejects traversal.
    const absolute = path.join(root, relative);
    if (!absolute.startsWith(rootPrefix)) return next();
    let entry;
    try {
      entry = await load(relative, absolute);
    } catch {
      return next(); // missing/unreadable: keep the previous 404 path
    }
    // Unknown extensions fall through to `express.static` so their MIME type and
    // byte handling stay exactly as before.
    if (!entry || !entry.contentType) return next();

    res.setHeader("Cache-Control", ASSET_CACHE_CONTROL);
    res.setHeader("Content-Type", entry.contentType);
    res.setHeader("Last-Modified", entry.lastModified);
    // The response body depends on Accept-Encoding for every compressible asset,
    // so the variant is declared even when this request gets the identity body.
    if (entry.compressible) res.setHeader("Vary", "Accept-Encoding");

    const useGzip = entry.compressible && acceptsGzip(req.headers["accept-encoding"]);
    const etag = useGzip ? entry.gzipEtag : entry.etag;
    res.setHeader("ETag", etag);
    const ifNoneMatch = req.headers["if-none-match"];
    if (ifNoneMatch && String(ifNoneMatch).split(",").some((candidate) => {
      const value = candidate.trim();
      return value === etag || value === `W/${etag}` || value === "*";
    })) {
      return res.status(304).end();
    }

    let payload = entry.body;
    if (useGzip) {
      entry.gzip ??= gzipSync(entry.body, { level: GZIP_LEVEL });
      payload = entry.gzip;
      res.setHeader("Content-Encoding", "gzip");
    }
    res.setHeader("Content-Length", String(payload.length));
    if (req.method === "HEAD") return res.end();
    return res.end(payload);
  };
}
