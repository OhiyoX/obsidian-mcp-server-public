#!/usr/bin/env node
// PWA install-metadata assets (issue #471, P1 slice).
//
// This script owns the committed PNG icon set and the committed Web App Manifest. Both
// are generated from one vector source, so the manifest's icon URLs stay content
// addressed (`?v=<sha256[:16]>`, the same convention `src/app/pages.js` uses for every
// shell asset) without hand-editing anything.
//
//   source : src/app/assets/favicon.svg   (512x512 viewBox, no background)
//   outputs: src/app/assets/icon-192.png            192x192  transparent, `purpose: any`
//            src/app/assets/icon-512.png            512x512  transparent, `purpose: any`
//            src/app/assets/icon-maskable-512.png   512x512  opaque, art inside the maskable safe zone
//            src/app/assets/apple-touch-icon-180.png 180x180 opaque (iOS composites the tile)
//            src/app/assets/manifest.webmanifest    rewritten with the hashes above
//
// Regenerate (from `app/`):  node scripts/make-pwa-icons.mjs
// Runtime: Playwright + the same pinned full Chromium the browser gate uses
// (`scripts/web-regression/chromium-binary.mjs`), so a rasterization is never produced by
// `chrome-headless-shell`. `PLAYWRIGHT_MODULE` / `CHROMIUM_EXECUTABLE` /
// `PLAYWRIGHT_BROWSERS_PATH` are honored exactly like the harness.
//
// The maskable scale is *measured*, not guessed: the script rasterizes the art, reads the
// alpha channel and picks the largest scale whose every ink pixel still sits inside the
// W3C maskable safe circle (radius = 40% of the icon size) with a 2% margin. The
// committed PNGs are re-checked pixel-by-pixel by
// `test/web-pwa-install-metadata.test.js`, which also fails when a PNG and the manifest's
// `?v=` no longer agree.
//
// CI note: `npm run build:web` does not touch these files, so the workflow's
// `git diff --exit-code -- app/src/app/assets` guard stays meaningful.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { exportHarnessChromiumExecutable, loadPlaywrightChromium, playwrightRuntimeExecutablePath } from "./web-regression/chromium-binary.mjs";

const appRoot = path.resolve(import.meta.dirname, "..");
const assetsDir = path.join(appRoot, "src", "app", "assets");
const sourceSvg = path.join(assetsDir, "favicon.svg");
const manifestPath = path.join(assetsDir, "manifest.webmanifest");

// W3C "maskable" safe zone: the guaranteed-visible circle has a diameter of 80% of the
// icon, so any ink at a radius > 40% of the size may be cropped by the platform mask.
const SAFE_RADIUS_RATIO = 0.4;
const SAFE_MARGIN = 0.98; // keep 2% clear of the circle so antialiasing cannot cross it
const ALPHA_THRESHOLD = 8; // out of 255; below this a pixel is treated as empty
const BACKGROUND = "#ffffff"; // the app's light surface, and the manifest background/theme color
const SHORT_NAME = "Obsidian Web";
const MANIFEST_NAME = "Obsidian Web";
const MANIFEST_DESCRIPTION = "NAS Obsidian 工作区（Web 应用壳）";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const assetUrl = (name, bytes) => `/app/assets/${name}?v=${digest(bytes).slice(0, 16)}`;
const bytesOf = (text) => Buffer.from(text, "utf8");

/** Replaces the SVG's percentage sizing with an explicit square so it has a real intrinsic size. */
function svgAtSize(svg, size) {
  const sized = svg.replace('height="100%"', `height="${size}"`).replace('width="100%"', `width="${size}"`);
  if (sized === svg || /(?:height|width)="100%"/.test(sized)) {
    throw new Error(`favicon.svg no longer uses the expected height="100%" width="100%" sizing; update make-pwa-icons.mjs`);
  }
  return sized;
}

const dataUrl = (svg) => `data:image/svg+xml;base64,${bytesOf(svg).toString("base64")}`;

const chromium = await loadPlaywrightChromium();
const { executablePath, source } = exportHarnessChromiumExecutable({ defaultExecutablePath: playwrightRuntimeExecutablePath(chromium) });
const svg = await fs.readFile(sourceSvg, "utf8");
const browser = await chromium.launch({ headless: true, executablePath });

try {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });

  // 1. Measure the art: bounding box plus the furthest ink pixel from the centre. The
  //    canvas is fed the 512x512-sized markup, so it is a 1:1 raster of the source.
  const ink = await page.evaluate(async ({ url, threshold }) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, 512, 512);
    const { data } = context.getImageData(0, 0, 512, 512);
    const box = { minX: 512, minY: 512, maxX: -1, maxY: -1, maxRadius: 0, pixels: 0 };
    for (let y = 0; y < 512; y += 1) {
      for (let x = 0; x < 512; x += 1) {
        if (data[(y * 512 + x) * 4 + 3] <= threshold) continue;
        box.pixels += 1;
        if (x < box.minX) box.minX = x;
        if (x > box.maxX) box.maxX = x;
        if (y < box.minY) box.minY = y;
        if (y > box.maxY) box.maxY = y;
        const radius = Math.hypot(x + 0.5 - 256, y + 0.5 - 256);
        if (radius > box.maxRadius) box.maxRadius = radius;
      }
    }
    return box;
  }, { url: dataUrl(svgAtSize(svg, 512)), threshold: ALPHA_THRESHOLD });
  if (ink.pixels === 0) throw new Error("favicon.svg rendered no ink at 512x512");

  // 2. Largest art scale whose ink stays inside the maskable safe circle.
  const artScale = Math.floor((SAFE_RADIUS_RATIO * 512 * SAFE_MARGIN / ink.maxRadius) * 1000) / 1000;

  async function renderPng({ size, scale, opaque }) {
    const art = Math.round(size * scale);
    const offset = Math.round((size - art) / 2);
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      [
        `<style>html,body{margin:0;padding:0;${opaque ? `background:${BACKGROUND};` : ""}}</style>`,
        `<div style="position:fixed;left:${offset}px;top:${offset}px;width:${art}px;height:${art}px">`,
        svgAtSize(svg, art),
        "</div>",
      ].join(""),
      { waitUntil: "load" },
    );
    return page.screenshot({ omitBackground: !opaque });
  }

  const outputs = [
    { name: "icon-192.png", size: 192, scale: 1, opaque: false },
    { name: "icon-512.png", size: 512, scale: 1, opaque: false },
    { name: "icon-maskable-512.png", size: 512, scale: artScale, opaque: true },
    { name: "apple-touch-icon-180.png", size: 180, scale: artScale, opaque: true },
  ];
  const written = [];
  for (const output of outputs) {
    const png = await renderPng(output);
    await fs.writeFile(path.join(assetsDir, output.name), png);
    written.push({ ...output, bytes: png.length, url: assetUrl(output.name, png) });
  }

  // 3. The manifest: scope / id / start_url are one string (#471 R5 — a `start_url` of
  //    `/app` would fall outside `scope: "/app/"` and trigger a scope fallback).
  const byName = Object.fromEntries(written.map((entry) => [entry.name, entry]));
  const manifest = {
    name: MANIFEST_NAME,
    short_name: SHORT_NAME,
    description: MANIFEST_DESCRIPTION,
    id: "/app/",
    start_url: "/app/",
    scope: "/app/",
    display: "standalone",
    background_color: BACKGROUND,
    theme_color: BACKGROUND,
    lang: "zh-CN",
    icons: [
      { src: byName["icon-192.png"].url, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: byName["icon-512.png"].url, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: byName["icon-maskable-512.png"].url, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
  const manifestBytes = bytesOf(`${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(manifestPath, manifestBytes);

  console.log(`make-pwa-icons: chromium=${await browser.version()} (${source} ${executablePath})`);
  console.log(`make-pwa-icons: source=${path.relative(appRoot, sourceSvg)} sha256=${digest(bytesOf(svg)).slice(0, 16)}`);
  console.log(
    `make-pwa-icons: ink bbox x[${ink.minX}..${ink.maxX}] y[${ink.minY}..${ink.maxY}] ` +
      `maxRadius=${ink.maxRadius.toFixed(2)}px (512 canvas) alphaPixels=${ink.pixels}`,
  );
  console.log(`make-pwa-icons: maskable/apple art scale=${artScale} (safe circle r=${(SAFE_RADIUS_RATIO * 512).toFixed(1)}px, margin ${((1 - SAFE_MARGIN) * 100).toFixed(0)}%)`);
  for (const entry of written) console.log(`make-pwa-icons: ${entry.name} ${entry.size}x${entry.size} bytes=${entry.bytes} url=${entry.url}`);
  console.log(`make-pwa-icons: manifest.webmanifest bytes=${manifestBytes.length} url=${assetUrl("manifest.webmanifest", manifestBytes)}`);
} finally {
  await browser.close();
}
