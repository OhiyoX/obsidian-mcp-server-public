// #471 (P1): install metadata for the Web app shell — manifest, icon set, page head and CSP.
//
// The whole slice is asserted against real HTTP bytes (real Express router, real login
// session, real `http.createServer`) and against the real PNG files, never against the
// `pages.js` source text:
//
//   1. `/app`, `/app/note/*` and `/app/base/*` ship one shared manifest link, the Apple
//      standalone metadata and exactly one `theme-color` writer;
//   2. the manifest is served as `application/manifest+json` under the immutable asset
//      policy, parses, and keeps `id` / `start_url` / `scope` on the same `/app/` string
//      (#471 R5: a `start_url` of `/app` would fall outside `scope: "/app/"`);
//   3. every declared icon is a real PNG of the declared pixel size, content-addressed by
//      the `?v=` query it is referenced with (a changed icon without a regenerated
//      manifest fails here);
//   4. the maskable icon is decoded pixel by pixel: it fills the whole canvas and no ink
//      pixel leaves the W3C maskable safe circle (radius = 40% of the icon);
//   5. the anonymous login page inherits the shared CSP permission but ships no manifest,
//      and Publish keeps its own independent CSP (no `manifest-src`, no manifest link).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import express from "express";

const ASSETS_DIR = new URL("../src/app/assets/", import.meta.url);
const MANIFEST_NAME = "manifest.webmanifest";
const SAFE_RADIUS_RATIO = 0.4;

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-pwa-install-"));
const vault = path.join(root, "vault");
await fs.mkdir(vault, { recursive: true });
await fs.writeFile(path.join(vault, "Note.md"), "# Note\n", "utf8");
await fs.writeFile(path.join(vault, "Project.base"), "views:\n  - name: All\n", "utf8");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = path.join(root, "data");
delete process.env.WEB_VAULTS_ROOT;

const [{ createWebAppRouter }, { encodeDocumentRoute }] = await Promise.all([
  import("../src/app/routes.js"),
  import("../src/publish/service.js"),
]);

const user = {
  id: "user-pwa-install",
  username: "owner",
  displayName: "Owner",
  updatedAt: "v1",
  allowedScopes: ["obsidian.read", "obsidian.write"],
  allowedVaults: ["default"],
};
const provider = {
  authenticateOAuthUser: async (username, password) => (username === "owner" && password === "password" ? user : null),
  oauthUserSessionRecord: async (id) => (id === user.id ? user : null),
  recordAudit() {},
};
// A stand-in for a published note: `/publish/:id` only needs a resolvable record here, and
// its purpose in this file is the *independent* CSP the route sets for itself.
const publishService = {
  resolve: async (id) => ({
    record: { id, path: "Note.md", createdAt: "2026-10-10T00:00:00.000Z" },
    note: { content: "# Published\n" },
  }),
};

test.after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function withServer(fn) {
  const app = express();
  app.use(createWebAppRouter({ provider, secureCookie: false, publishService }));
  const server = await new Promise((resolve, reject) => {
    const instance = http.createServer(app);
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Real HTTP response for one URL behind a real login session. */
async function authedFetch(base, urlPath) {
  const login = await fetch(`${base}/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "owner", password: "password" }),
  });
  assert.equal(login.status, 303, "the fixture login must succeed before the page can be read");
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const response = await fetch(`${base}${urlPath}`, { headers: { Cookie: cookie } });
  return { response, body: await response.text() };
}

const headOf = (html) => String(html).match(/<head>[\s\S]*?<\/head>/)?.[0] ?? "";
const links = (html, rel) =>
  [...String(html).matchAll(/<link\b[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => new RegExp(`\\brel="${rel}"`).test(tag));
const metas = (html, name) =>
  [...String(html).matchAll(/<meta\b[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => new RegExp(`\\bname="${name}"`).test(tag));
const attr = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null;
const sha256_16 = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);

// --- minimal PNG reader (8-bit, non-interlaced) for the committed icon bytes ----------
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
function decodePng(buffer) {
  assert.equal(buffer.readUInt32BE(0), 0x89504e47, "PNG signature");
  let offset = 8;
  let header = null;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  assert.ok(header, "IHDR chunk present");
  assert.equal(header.bitDepth, 8, "8 bits per channel");
  assert.equal(header.interlace, 0, "non-interlaced PNG");
  const channels = CHANNELS[header.colorType];
  assert.ok(channels, `supported PNG color type (got ${header.colorType})`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = header.width * channels;
  const pixels = Buffer.alloc(header.height * stride);
  let cursor = 0;
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[cursor];
    cursor += 1;
    const line = raw.subarray(cursor, cursor + stride);
    cursor += stride;
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? out[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) value += paeth(a, b, c);
      else assert.equal(filter, 0, `supported scanline filter (got ${filter})`);
      out[i] = value & 0xff;
    }
  }
  return {
    header,
    channels,
    stride,
    pixels,
    alphaAt: (x, y) => (channels === 4 ? pixels[y * stride + x * 4 + 3] : 255),
    rgbAt: (x, y) => {
      const base = y * stride + x * channels;
      return channels === 1 || channels === 2
        ? [pixels[base], pixels[base], pixels[base]]
        : [pixels[base], pixels[base + 1], pixels[base + 2]];
    },
  };
}

/** Ink = anything that is neither transparent nor the opaque white canvas. */
function inkStats(png) {
  const { width, height } = png.header;
  const stats = { minX: width, minY: height, maxX: -1, maxY: -1, pixels: 0, maxRadius: 0, transparent: 0 };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (png.alphaAt(x, y) <= 8) {
        stats.transparent += 1;
        continue;
      }
      const [r, g, b] = png.rgbAt(x, y);
      if (r > 247 && g > 247 && b > 247) continue; // the opaque white canvas
      stats.pixels += 1;
      if (x < stats.minX) stats.minX = x;
      if (x > stats.maxX) stats.maxX = x;
      if (y < stats.minY) stats.minY = y;
      if (y > stats.maxY) stats.maxY = y;
      stats.maxRadius = Math.max(stats.maxRadius, Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2));
    }
  }
  return stats;
}

// --- 1. page head ---------------------------------------------------------------------
test("#471 P1: /app, /app/note/* and /app/base/* share one manifest link and the Apple standalone metadata", async () => {
  const basePageRoute = `/app/base/${encodeDocumentRoute("default", "Project.base")}`;
  const noteRoute = `/app/note/${encodeDocumentRoute("default", "Note.md")}`;
  await withServer(async (base) => {
    const heads = [];
    for (const urlPath of ["/app", noteRoute, basePageRoute]) {
      const { response, body } = await authedFetch(base, urlPath);
      assert.equal(response.status, 200, `${urlPath} must render the shell`);
      heads.push([urlPath, headOf(body), response.headers.get("content-security-policy") || ""]);
    }
    const manifestHrefs = new Set();
    for (const [urlPath, head, csp] of heads) {
      const manifestLinks = links(head, "manifest");
      assert.equal(manifestLinks.length, 1, `${urlPath} must ship exactly one manifest link`);
      assert.match(attr(manifestLinks[0], "href"), /^\/app\/assets\/manifest\.webmanifest\?v=[0-9a-f]{16}$/, `${urlPath} manifest link must be content-addressed`);
      manifestHrefs.add(attr(manifestLinks[0], "href"));

      const appleIcons = links(head, "apple-touch-icon");
      assert.equal(appleIcons.length, 1, `${urlPath} must ship exactly one apple-touch-icon link`);
      assert.equal(attr(appleIcons[0], "sizes"), "180x180");
      assert.match(attr(appleIcons[0], "href"), /^\/app\/assets\/apple-touch-icon-180\.png\?v=[0-9a-f]{16}$/);

      assert.equal(attr(metas(head, "apple-mobile-web-app-capable")[0] ?? "", "content"), "yes");
      assert.equal(attr(metas(head, "apple-mobile-web-app-status-bar-style")[0] ?? "", "content"), "black-translucent");
      assert.equal(attr(metas(head, "apple-mobile-web-app-title")[0] ?? "", "content"), "Obsidian Web");

      // #471 R5: no second `theme-color` writer, and the viewport prerequisite for a
      // non-zero `env(safe-area-inset-top)` stays exactly as #369 left it.
      assert.equal(metas(head, "theme-color").length, 1, `${urlPath} must keep exactly one theme-color meta`);
      const viewport = metas(head, "viewport");
      assert.equal(viewport.length, 1);
      assert.match(attr(viewport[0], "content"), /viewport-fit=cover/);

      assert.match(csp, /manifest-src 'self'/, `${urlPath} CSP must permit its own manifest`);
    }
    assert.equal(manifestHrefs.size, 1, `app, note and Base must share one manifest URL, got ${[...manifestHrefs].join(", ")}`);
  });
});

test("#471 P1: the login page inherits the CSP permission but ships no manifest, and Publish keeps its own CSP", async () => {
  await withServer(async (base) => {
    const login = await fetch(`${base}/auth/login`);
    const loginBody = await login.text();
    assert.equal(login.status, 200);
    assert.match(login.headers.get("content-security-policy") || "", /manifest-src 'self'/, "login inherits the shared header");
    assert.equal(links(headOf(loginBody), "manifest").length, 0, "the anonymous login page deliberately ships no manifest");

    const published = await fetch(`${base}/publish/${"a".repeat(43)}`);
    const publishedBody = await published.text();
    assert.equal(published.status, 200, "the stub publish record must render");
    const publishCsp = published.headers.get("content-security-policy") || "";
    assert.doesNotMatch(publishCsp, /manifest-src/, "Publish keeps its own independent CSP");
    assert.match(publishCsp, /connect-src 'none'/, "Publish CSP is unchanged");
    assert.equal(links(headOf(publishedBody), "manifest").length, 0, "Publish stays independent of the app manifest");
  });
});

// --- 2. manifest ----------------------------------------------------------------------
test("#471 P1: the manifest is served as application/manifest+json under the immutable asset policy and keeps one /app/ scope", async () => {
  const manifestBytes = await fs.readFile(new URL(MANIFEST_NAME, ASSETS_DIR));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  await withServer(async (base) => {
    const { response, body } = await authedFetch(base, "/app");
    const href = attr(links(headOf(body), "manifest")[0], "href");
    const manifestResponse = await fetch(`${base}${href}`);
    assert.equal(manifestResponse.status, 200);
    assert.match(manifestResponse.headers.get("content-type") || "", /^application\/manifest\+json/, "manifest MIME type");
    const cacheControl = manifestResponse.headers.get("cache-control") || "";
    assert.match(cacheControl, /immutable/);
    assert.doesNotMatch(cacheControl, /no-store/);
    assert.match(cacheControl, /max-age=31536000/);
    assert.equal(manifestResponse.headers.get("x-content-type-options"), "nosniff");
    const served = Buffer.from(await manifestResponse.arrayBuffer());
    assert.deepEqual(served, manifestBytes, "the served manifest must be the committed file");
    assert.equal(sha256_16(served), href.split("?v=")[1], "the shell's ?v= must be the manifest's own content hash");

    const parsed = JSON.parse(served.toString("utf8"));
    assert.equal(parsed.name, "Obsidian Web");
    assert.equal(parsed.short_name, "Obsidian Web");
    assert.equal(parsed.lang, "zh-CN");
    assert.equal(parsed.display, "standalone");
    // #471 R5: `start_url` must live inside `scope`, and `id` keeps the install identity stable.
    assert.equal(parsed.id, "/app/");
    assert.equal(parsed.start_url, "/app/");
    assert.equal(parsed.scope, "/app/");
    assert.match(parsed.background_color, /^#[0-9a-f]{6}$/);
    assert.match(parsed.theme_color, /^#[0-9a-f]{6}$/);
    assert.deepEqual(parsed, manifest, "the committed manifest must parse to the same object");
  });
});

// --- 3./4. icons ----------------------------------------------------------------------
test("#471 P1: the declared icon set is served as real PNGs of the declared size with immutable caching", async () => {
  const manifest = JSON.parse(await fs.readFile(new URL(MANIFEST_NAME, ASSETS_DIR), "utf8"));
  const purposes = manifest.icons.map((icon) => icon.purpose);
  assert.deepEqual([...purposes].sort(), ["any", "any", "maskable"], "192 + 512 any icons plus one dedicated maskable icon");
  assert.deepEqual(manifest.icons.map((icon) => icon.sizes), ["192x192", "512x512", "512x512"]);
  const maskable = manifest.icons.find((icon) => icon.purpose === "maskable");
  const square = manifest.icons.find((icon) => icon.purpose === "any" && icon.sizes === "512x512");
  assert.notEqual(maskable.src, square.src, "the maskable icon must be its own file, not the 512 reused");

  const disk = new Map();
  for (const icon of manifest.icons) {
    const name = path.basename(new URL(icon.src, "http://local").pathname);
    disk.set(icon.src, await fs.readFile(new URL(name, ASSETS_DIR)));
  }
  const appleBytes = await fs.readFile(new URL("apple-touch-icon-180.png", ASSETS_DIR));

  await withServer(async (base) => {
    const { body } = await authedFetch(base, "/app");
    const head = headOf(body);
    const appleHref = attr(links(head, "apple-touch-icon")[0], "href");
    const targets = [...manifest.icons.map((icon) => [icon.src, icon.sizes]), [appleHref, "180x180"]];
    for (const [src, sizes] of targets) {
      const response = await fetch(`${base}${src}`);
      assert.equal(response.status, 200, `${src} must be served`);
      assert.equal(response.headers.get("content-type"), "image/png", `${src} MIME type`);
      assert.match(response.headers.get("cache-control") || "", /immutable/);
      const bytes = Buffer.from(await response.arrayBuffer());
      const png = decodePng(bytes);
      const [width, height] = sizes.split("x").map(Number);
      assert.equal(png.header.width, width, `${src} real pixel width`);
      assert.equal(png.header.height, height, `${src} real pixel height`);
      const expected = src === appleHref ? appleBytes : disk.get(src);
      assert.deepEqual(bytes, expected, `${src} must be the committed file`);
      assert.equal(sha256_16(bytes), src.split("?v=")[1], `${src} ?v= must be its own content hash`);
    }
  });
});

test("#471 P1: the maskable icon fills its canvas and keeps every ink pixel inside the maskable safe circle", async () => {
  const manifest = JSON.parse(await fs.readFile(new URL(MANIFEST_NAME, ASSETS_DIR), "utf8"));
  const maskableSrc = manifest.icons.find((icon) => icon.purpose === "maskable").src;
  const maskable = decodePng(await fs.readFile(new URL(path.basename(new URL(maskableSrc, "http://local").pathname), ASSETS_DIR)));
  const size = maskable.header.width;
  assert.equal(size, maskable.header.height);

  // Maskable: the platform may crop everything outside the safe circle, so the canvas
  // itself must be fully painted — a transparent edge would show as a hole.
  for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1], [size >> 1, 0], [0, size >> 1]]) {
    assert.equal(maskable.alphaAt(x, y), 255, `maskable canvas must be opaque at ${x},${y}`);
  }
  const ink = inkStats(maskable);
  assert.ok(ink.pixels > 0, "the maskable icon must contain artwork");
  const centre = (size - 1) / 2;
  assert.ok(Math.abs((ink.minX + ink.maxX) / 2 - centre) <= 1.5, `art must be horizontally centred (${ink.minX}..${ink.maxX})`);
  assert.ok(Math.abs((ink.minY + ink.maxY) / 2 - centre) <= 1.5, `art must be vertically centred (${ink.minY}..${ink.maxY})`);
  const safeRadius = SAFE_RADIUS_RATIO * size;
  assert.ok(
    ink.maxRadius <= safeRadius,
    `every ink pixel must stay inside the maskable safe circle: maxRadius=${ink.maxRadius.toFixed(2)} > ${safeRadius.toFixed(2)}`,
  );
  assert.ok(ink.maxRadius > safeRadius * 0.9, `the art must use the safe zone it was scaled for (maxRadius=${ink.maxRadius.toFixed(2)})`);
  assert.ok((ink.maxX - ink.minX + 1) >= size * 0.5, "the maskable artwork must be a real icon, not a dot");

  // The transparent variants stay distinct: the 512 `any` icon must not carry the maskable
  // canvas (a transparent corner is what makes the browser's own mask visible).
  const square = decodePng(await fs.readFile(new URL("icon-512.png", ASSETS_DIR)));
  assert.equal(square.alphaAt(0, 0), 0, "the `any` 512 icon must keep a transparent corner");
  assert.ok(inkStats(square).pixels > ink.pixels, "the `any` icon draws the art larger than the maskable one");
});
