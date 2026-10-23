// Web first-load budget gate (#414) — deterministic byte and header contracts.
//
// Why headers and bytes, never wall-clock: contract §6.6 / §14.8 (the rule
// `test/bases-perf-baseline.test.js` records) allows a hard budget only when it
// comes from repeated stable measurements on one runner, never from a guessed
// millisecond. So the gates here are:
//   1. HTTP header policy — `/app/assets/*` must be publicly cacheable for at
//      least a day and must not carry `no-store`, while `/app` and
//      `/api/web/v1/*` must *keep* `no-store` (reverse assertion: the fix must
//      not delete the per-session policy);
//   2. gzip negotiation — the same bytes after `gunzip`, and no compression when
//      the client did not ask for it;
//   3. the shell's eager `<script src>` set — issue #414 (part C) keeps only
//      `theme-boot.js` + `app-loader.js` there, and the served loader must expose
//      the on-demand contract (`ensureEditor`/`ensureReader`);
//   4. three byte ratchets against `scripts/web-firstload-baseline.json`, each
//      `<=` only: the shell's eager raw bytes, the real first-screen gzip bytes
//      (shell-critical assets), the deferred bundles' gzip bytes, and the
//      coordinator's original five-asset total so nothing can be "moved out" of
//      the budget instead of removed from the critical path.
//
// Browser timings (time-to-first-list / DCL / load / transfer bytes) are NOT part
// of this gate. They live in `scripts/web-firstload-metric.mjs`, which records
// JSON for humans and deliberately has no threshold.
//
// Run: cd app && node --test test/web-firstload-budget.test.js

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { ICON_SPRITE_ATTR, iconHref } from "../frontend/app/ui/icons.js";

const APP_DIR = path.resolve(import.meta.dirname, "..");
const ASSETS_DIR = path.join(APP_DIR, "src", "app", "assets");
const BASELINE_PATH = path.join(APP_DIR, "scripts", "web-firstload-baseline.json");
const WEB_USERNAME = "firstload-budget";
const WEB_PASSWORD = "firstload-budget-password";
const DAY_SECONDS = 24 * 60 * 60;

// U38 (#571): a sprite reference is only cache-safe when it carries the content hash the
// shell published. Anything else is served from the one-year `immutable` entry.
const VERSIONED_SPRITE_RE = /^\/app\/assets\/icons\.svg\?v=[0-9a-f]{16}#[a-z0-9-]+$/;
function unversionedSpriteRefs(markup) {  return [...String(markup).matchAll(/\/app\/assets\/icons\.svg(?!\?v=[0-9a-f]{16}#)[^"']*?#[a-z0-9-]+/g)].map((match) => match[0]);
}
function countUnversionedSpriteLiterals(text) {
  return (String(text).match(/icons\.svg#/g) ?? []).length;
}
// The published sprite URL a page hands to the client half (`ui/icons.js` reads it back
// through `data-icon-sprite`). Returns null when the page does not publish it, so the
// assertion below fails loudly instead of comparing against `undefined`.
function iconSpriteFrom(markup) {
  return new RegExp(`<html[^>]*\\s${ICON_SPRITE_ATTR}="([^"]+)"`).exec(String(markup))?.[1] ?? null;
}
// No client bundle may build the sprite URL by hand: `ui/icons.js` is the single resolver, so
// every `icons.svg#` literal in a built bundle is an unversioned reference waiting to pin the
// symbol set for a year. The recorded remainder is empty (was app.js: 5 before #571).
const SPRITE_LITERAL_REMAINDER = { "app.js": 0, "editor.js": 0, "reader.js": 0 };

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

// Never hang the suite: register the exit listener before killing, escalate once.
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    let escalate;
    const finish = () => { clearTimeout(escalate); resolve(); };
    child.once("exit", finish);
    escalate = setTimeout(() => { child.kill("SIGKILL"); finish(); }, 5000);
    escalate.unref?.();
    child.kill();
  });
}

async function startServer(env, base) {
  const child = spawn(process.execPath, ["server.js"], { cwd: APP_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  for (let attempt = 0; attempt < 450; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${output.join("")}`);
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) return child;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await stopChild(child);
  throw new Error(`timed out waiting for the server: ${output.join("")}`);
}

// Raw `node:http`: unlike fetch/undici it never decompresses for us, so the
// assertion can compare the exact bytes that left the origin.
function request(url, { method = "GET", headers = {}, body = null } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const payload = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: payload, text: payload.toString("utf8") });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function loginCookie(base) {
  // The slash-less app root is still an accepted `next`; #471 normalises it to the slash form so
  // the post-login landing page stays inside the installed app's resolved `scope` (`/app/`).
  const body = new URLSearchParams({ username: WEB_USERNAME, password: WEB_PASSWORD, next: "/app" }).toString();
  const response = await request(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
    body,
  });
  assert.equal(response.status, 303, "login must redirect to the app shell");
  assert.equal(response.headers.location, "/app/", "the accepted slash-less app root lands on the slash form");
  const cookie = (response.headers["set-cookie"] || []).map((value) => value.split(";")[0]).join("; ");
  assert.match(cookie, /=/, "login must set a session cookie");
  return cookie;
}

test("web first-load budget (#414): asset cache policy, gzip negotiation and byte ratchet", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-firstload-"));
  const vault = path.join(root, "vault");
  await fs.mkdir(vault, { recursive: true });
  await fs.writeFile(path.join(vault, "note.md"), "# first-load budget fixture\n\nbody\n", "utf8");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = await startServer({
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    VAULT_PATH: vault,
    DATA_PATH: path.join(root, "data"),
    OAUTH_ENABLED: "true",
    PUBLIC_BASE_URL: base,
    OAUTH_INITIAL_USERNAME: WEB_USERNAME,
    OAUTH_INITIAL_PASSWORD: WEB_PASSWORD,
    OAUTH_ADMIN_PASSWORD: WEB_PASSWORD,
    API_KEY: "",
    GIT_ENABLED: "false",
    EMBEDDING_PROVIDER: "disabled",
  }, base);
  t.after(async () => {
    await stopChild(child);
    await fs.rm(root, { recursive: true, force: true });
  });

  const baseline = JSON.parse(await fs.readFile(BASELINE_PATH, "utf8"));
  const shell = await request(`${base}/app`, { headers: { cookie: await loginCookie(base) } });
  assert.equal(shell.status, 200, "the app shell must render for the budget probe");

  await t.test("assets are publicly cacheable for at least a day, still nosniff", async () => {
    for (const name of baseline.firstScreenAssets) {
      const response = await request(`${base}/app/assets/${name}`);
      assert.equal(response.status, 200, `${name} must be served`);
      const cacheControl = String(response.headers["cache-control"] || "");
      assert.ok(!/no-store/i.test(cacheControl), `${name} must not be no-store (got "${cacheControl}")`);
      const maxAge = Number(/max-age=(\d+)/i.exec(cacheControl)?.[1] ?? 0);
      assert.ok(maxAge >= DAY_SECONDS, `${name} must be cacheable for >= 1 day (got "${cacheControl}")`);
      assert.match(cacheControl, /immutable/, `${name} must be immutable`);
      assert.equal(response.headers["x-content-type-options"], "nosniff", `${name} must keep nosniff`);
      assert.ok(response.headers["content-security-policy"], `${name} must keep the CSP`);
    }
  });

  await t.test("per-session routes keep no-store (reverse assertion)", async () => {
    const cases = [
      { name: "/app", response: await request(`${base}/app`) },
      { name: "/auth/login", response: await request(`${base}/auth/login`) },
      { name: "/api/web/v1/session", response: await request(`${base}/api/web/v1/session`) },
    ];
    for (const { name, response } of cases) {
      const cacheControl = String(response.headers["cache-control"] || "");
      assert.equal(cacheControl, "no-store", `${name} must stay no-store (got "${cacheControl}")`);
    }
  });

  await t.test("gzip is negotiated, byte-identical and never the default", async () => {
    const url = `${base}/app/assets/app.js`;
    const disk = await fs.readFile(path.join(ASSETS_DIR, "app.js"));
    const identity = await request(url);
    assert.equal(identity.headers["content-encoding"], undefined, "identity request must not be compressed");
    assert.deepEqual(identity.body, disk, "identity body must be the file bytes");
    assert.equal(Number(identity.headers["content-length"]), identity.body.length);
    assert.match(String(identity.headers.vary || ""), /accept-encoding/i, "a compressible asset must declare Vary: Accept-Encoding");

    for (const header of ["gzip", "gzip, deflate, br", "br;q=1.0, gzip;q=0.8"]) {
      const compressed = await request(url, { headers: { "Accept-Encoding": header } });
      assert.equal(compressed.headers["content-encoding"], "gzip", `Accept-Encoding: ${header} must select gzip`);
      assert.equal(Number(compressed.headers["content-length"]), compressed.body.length, "Content-Length must describe the compressed body");
      assert.deepEqual(gunzipSync(compressed.body), disk, `gunzip must reproduce the original bytes for "${header}"`);
      assert.match(String(compressed.headers.vary || ""), /accept-encoding/i);
    }

    for (const header of ["identity", "gzip;q=0", "deflate"]) {
      const plain = await request(url, { headers: { "Accept-Encoding": header } });
      assert.equal(plain.headers["content-encoding"], undefined, `Accept-Encoding: ${header} must stay identity`);
      assert.deepEqual(plain.body, disk);
    }

    // Already-compressed formats must not grow a gzip frame.
    const fonts = (await fs.readdir(path.join(ASSETS_DIR, "fonts"))).filter((entry) => entry.endsWith(".woff2"));
    assert.ok(fonts.length > 0, "the asset fonts directory must ship at least one woff2");
    const font = await request(`${base}/app/assets/fonts/${fonts[0]}`, { headers: { "Accept-Encoding": "gzip" } });
    assert.equal(font.status, 200);
    assert.equal(font.headers["content-encoding"], undefined, "woff2 is already compressed and must stay raw");
    assert.deepEqual(font.body, await fs.readFile(path.join(ASSETS_DIR, "fonts", fonts[0])));
  });

  await t.test("the shell references versioned asset URLs", async () => {
    const references = [...shell.text.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="(\/app\/assets\/[^"]+)"/g)].map((match) => match[1]);
    // Issue #414 (C): the shell is theme-boot.js + app-loader.js (scripts) and the two
    // stylesheets; editor.js/reader.js are no longer shell <script> tags.
    assert.ok(references.length >= 4, `expected the shell script/link assets, got ${references.length}`);
    for (const reference of references) {
      assert.match(reference, /^\/app\/assets\/[\w.-]+\?v=[0-9a-f]{16}$/, `${reference} must carry the content-hash query`);
    }
    const scriptNames = [...shell.text.matchAll(/<script\b[^>]*?src="\/app\/assets\/([^"?]+)/g)].map((match) => match[1]);
    assert.deepEqual(scriptNames.sort(), [...baseline.shellEagerScripts].sort(), "shell <script src> set must match the baseline");
  });

  // U38 (#571): the sprite is answered under the same one-year `immutable` policy as every
  // other asset, so a reference without the content hash pins the symbol set for a year —
  // that is the #568 blank white box (the shell held a pre-#550 sprite and `#copy` resolved
  // to a 0x0 bbox). The reference and the publish point share one hash (pages.js
  // `assetUrl("icons.svg")`), so changing the file must change every reference.
  await t.test("every sprite reference in the served pages carries the published content hash (U38)", async () => {
    const { appPage, publishPage } = await import("../src/app/pages.js");
    const spriteHash = createHash("sha256").update(await fs.readFile(path.join(ASSETS_DIR, "icons.svg"))).digest("hex").slice(0, 16);
    const publishedSprite = `/app/assets/icons.svg?v=${spriteHash}`;
    const pages = [
      ["/app (served shell)", shell.text],
      ["appPage()", appPage({ username: WEB_USERNAME, displayName: "Budget", csrf: "csrf-token" }, {})],
      ["publishPage()", publishPage({ title: "budget", content: "", publishedAt: "" })],
    ];
    for (const [label, markup] of pages) {
      const references = [...markup.matchAll(/\/app\/assets\/icons\.svg[^"']*?#[a-z0-9-]+/g)].map((match) => match[0]);
      assert.ok(references.length > 0, `${label} must still use the icons.svg sprite`);
      for (const reference of references) {
        assert.ok(VERSIONED_SPRITE_RE.test(reference), `${label}: ${reference} must carry a 16-hex content hash`);
      }
      assert.deepEqual(unversionedSpriteRefs(markup), [], `${label} must carry no unversioned sprite reference`);
      // The client half is same-origin with the SSR half: the shell publishes the published
      // URL on <html>, the SSR references above carry it, and ui/icons.js reads it back for
      // every sprite glyph the bundles build at runtime (U38 #571).
      assert.equal(iconSpriteFrom(markup), publishedSprite, `${label} must publish the same sprite URL ui/icons.js resolves`);
      for (const reference of references) {
        assert.ok(reference.startsWith(`${publishedSprite}#`), `${label}: ${reference} must use the published sprite URL`);
      }
    }
  });

  // Negative control: the guard above must really fail on the shape it forbids, both for a
  // whole reference and for a template that builds one from a bare base URL.
  await t.test("the sprite-version guard fails on an unversioned reference (negative control)", () => {
    assert.deepEqual(unversionedSpriteRefs('<button>${icon("x")}</button>'.replace('${icon("x")}', '<svg class="svg-icon"><use href="/app/assets/icons.svg#x"></use></svg>')), ["/app/assets/icons.svg#x"]);
    assert.deepEqual(unversionedSpriteRefs('<use href="/app/assets/icons.svg?v=0123456789abcdef#x">'), []);
    assert.deepEqual(unversionedSpriteRefs('<use href="/app/assets/icons.svg?v=0123456789abcde#x">'), ["/app/assets/icons.svg?v=0123456789abcde#x"], "a short hash is not a content hash");
    assert.deepEqual(unversionedSpriteRefs('/app/assets/icons.svg#moon'), ["/app/assets/icons.svg#moon"]);
    // The bundle-literal counter is the second guard; it must count the shape it forbids.
    assert.equal(countUnversionedSpriteLiterals('/app/assets/icons.svg#x'), 1);
    assert.equal(countUnversionedSpriteLiterals('/app/assets/icons.svg?v=0123456789abcdef#x'), 0);
    assert.equal(countUnversionedSpriteLiterals('href="/app/assets/icons.svg" + "#" + name'), 0, "a base + concatenated fragment is not a literal; the ratchet bounds it per bundle");
    // The client resolver reads what the page published; these are its own controls: the
    // attribute wins, a page without it cannot pass `iconSpriteFrom` (null, not undefined),
    // and a stale hash is not the hash the served sprite hashes to.
    assert.equal(iconHref({ documentElement: { getAttribute: (name) => (name === ICON_SPRITE_ATTR ? "/app/assets/icons.svg?v=0123456789abcdef" : null) } }, "link"), "/app/assets/icons.svg?v=0123456789abcdef#link");
    assert.equal(iconHref({ documentElement: { getAttribute: () => null } }, "link"), "/app/assets/icons.svg#link", "the documented fallback keeps the glyph drawing off the shell");
    assert.equal(iconSpriteFrom('<html lang="zh-CN" data-icon-sprite="/app/assets/icons.svg?v=0123456789abcdef">'), "/app/assets/icons.svg?v=0123456789abcdef");
    assert.equal(iconSpriteFrom('<html lang="zh-CN">'), null, "a page that publishes no sprite URL must be caught, not compared as undefined");
    assert.notEqual(iconSpriteFrom('<html data-icon-sprite="/app/assets/icons.svg?v=0000000000000000">'), ` /app/assets/icons.svg?v=0123456789abcdef`.trim(), "a stale hash is not the published one");
  });

  // Every client bundle must resolve the sprite through ui/icons.js: #571 moved the last five
  // hand-built anchors (app.js) onto the shared resolver, so the recorded remainder is zero and
  // any new `icons.svg#` literal — i.e. an unversioned reference the one-year immutable entry
  // would pin — turns this red.
  await t.test("no client bundle carries an unversioned sprite literal (U38 zero tolerance)", async () => {
    for (const [name, recorded] of Object.entries(SPRITE_LITERAL_REMAINDER)) {
      const text = await fs.readFile(path.join(ASSETS_DIR, name), "utf8");
      const found = countUnversionedSpriteLiterals(text);
      assert.ok(
        found <= recorded,
        `${name} carries ${found} unversioned "icons.svg#" literal(s), above the recorded remainder ${recorded}; route the built sprite URL through ui/icons.js instead of adding one`,
      );
    }
  });

  await t.test("the shell loads its bundles on demand (issue #414 C)", async () => {
    const loader = await request(`${base}/app/assets/app-loader.js`);
    assert.equal(loader.status, 200, "the shell must serve app-loader.js");
    assert.match(loader.text, /window\.__obsidianWebAssets/, "the loader must publish the on-demand asset contract");
    assert.match(loader.text, /ensureEditor/, "the loader must expose ensureEditor");
    assert.match(loader.text, /ensureReader/, "the loader must expose ensureReader");
    // The shell must not fetch either bundle before the first list paints: the two
    // defer scripts below are the whole eager set, and neither is editor.js/reader.js.
    const scripts = [...shell.text.matchAll(/<script\b[^>]*?src="\/app\/assets\/([^"?]+)/g)].map((match) => match[1]).sort();
    assert.deepEqual(scripts, ["app-loader.js", "theme-boot.js"], `unexpected shell <script src> set: ${scripts.join(", ")}`);
  });

  await t.test("the application entry never touches the deferred globals at module scope (issue #414 C)", async () => {
    // The root cause of the eager 1.6 MB was `core/app.js` calling `window.createObsidianEditor`
    // while the module body runs. Keep that impossible: the entry goes through the deferred
    // facade / the reading bridge, which is what lets the shell paint first.
    const entry = await fs.readFile(path.join(APP_DIR, "frontend", "app", "core", "app.js"), "utf8");
    assert.ok(!entry.includes("window.createObsidianEditor"), "app.js must not use createObsidianEditor directly; go through the deferred facade");
    assert.ok(!entry.includes("window.renderObsidianMarkdown"), "app.js must not read renderObsidianMarkdown directly; go through renderMarkdownOrDefer");
  });

  // #504 review (Codex seat, HOLD on the first version) proved the previous check was a false
  // guard: it only matched keys indented with exactly two spaces, so a duplicate key written with
  // four spaces or a tab slipped past it while `JSON.parse` still resolved the budget to the last
  // value. Whitespace-agnostic and depth-aware now, and the file must stay canonically formatted.
  const duplicateKeys = (text) => {
    const stack = [new Set()];
    const duplicates = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "{") {
        stack.push(new Set());
        continue;
      }
      if (ch === "}") {
        stack.pop();
        continue;
      }
      if (ch !== '"') continue;
      let value = "";
      let j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] === "\\") {
          value += text[j + 1];
          j++;
          continue;
        }
        if (text[j] === '"') break;
        value += text[j];
      }
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k])) k++;
      if (text[k] === ":") {
        const scope = stack[stack.length - 1];
        if (scope.has(value)) duplicates.push(value);
        scope.add(value);
      }
      i = j;
    }
    return duplicates;
  };

  await t.test("the duplicate-key guard sees any indentation (controls: two spaces, four spaces, tab)", () => {
    assert.deepEqual(duplicateKeys('{\n  "a": 1,\n  "a": 2\n}'), ["a"], "two-space duplicate must be caught");
    assert.deepEqual(duplicateKeys('{\n  "a": 1,\n    "a": 2\n}'), ["a"], "four-space duplicate must be caught");
    assert.deepEqual(duplicateKeys('{\n\t"a": 1,\n\t"a": 2\n}'), ["a"], "tab duplicate must be caught");
    assert.deepEqual(duplicateKeys('{"a": 1, "b": 2}'), [], "distinct keys are not duplicates");
    assert.deepEqual(duplicateKeys('{"a": {"a": 1}, "b": 2}'), [], "the same name in a nested object is a different scope");
    assert.deepEqual(duplicateKeys('{"a": "x:y", "b": 2}'), [], "a colon inside a string value is not a key separator");
  });

  await t.test("the baseline file is canonical JSON with no duplicate keys", async () => {
    const text = await fs.readFile(BASELINE_PATH, "utf8");
    assert.deepEqual(duplicateKeys(text), [], `duplicate key(s) in ${path.relative(APP_DIR, BASELINE_PATH)}`);
    // Canonical form makes the guard above total: any reformat or stray duplicate changes the
    // text, so neither can hide behind whitespace the scanner does not expect. Line endings are
    // normalized first: a Windows checkout stores CRLF while the canonical form below is LF (the
    // repository normalizes the same way for every other fixture).
    assert.equal(
      `${JSON.stringify(JSON.parse(text), null, 2)}\n`,
      text.replace(/\r\n/g, "\n"),
      `${path.relative(APP_DIR, BASELINE_PATH)} must stay canonical (two-space JSON.stringify output plus a trailing newline)`,
    );
  });

  await t.test("first-load byte budgets stay within the baseline (ratchet: <=)", async () => {
    const rawBytes = async (names) => {
      let total = 0;
      for (const name of names) total += (await fs.stat(path.join(ASSETS_DIR, name))).size;
      return total;
    };
    const gzipBytes = async (names) => {
      let total = 0;
      const perAsset = [];
      for (const name of names) {
        const response = await request(`${base}/app/assets/${name}`, { headers: { "Accept-Encoding": "gzip" } });
        assert.equal(response.headers["content-encoding"], "gzip", `${name} must be gzip-negotiated for this measurement`);
        total += response.body.length;
        perAsset.push(`${name}=${response.body.length}`);
      }
      return { total, perAsset };
    };

    const shellRaw = await rawBytes(baseline.shellEagerScripts);
    const firstScreen = await gzipBytes(baseline.firstScreenAssets);
    const deferred = await gzipBytes(baseline.deferredAssets);
    const issue414 = await gzipBytes(baseline.issue414ComparisonSet);

    // On-demand assets (#571 ③, from the PR #577 review's coverage gap): mermaid.js is
    // fetched only by a document that really has a fence, so it sits in no eager set and
    // nothing used to bound it. Each entry carries its own measured gzip bound.
    const lazyAssets = [];
    for (const asset of baseline.lazyAssets) {
      const response = await request(`${base}/app/assets/${asset.name}`, { headers: { "Accept-Encoding": "gzip" } });
      assert.equal(response.status, 200, `${asset.name} must be served`);
      assert.equal(response.headers["content-encoding"], "gzip", `${asset.name} must gzip-negotiate for this measurement`);
      lazyAssets.push({ name: asset.name, measured: response.body.length, bound: asset.gzipBytes });
      assert.ok(
        response.body.length <= asset.gzipBytes,
        `on-demand asset ${asset.name} grew: ${response.body.length} > ${asset.gzipBytes} gzip; shrink it or re-measure and raise the bound with a written reason and the coordinator's sign-off`,
      );
    }
    console.log(`first-load budget: lazyAssets=[${lazyAssets.map((asset) => `${asset.name}=${asset.measured}/${asset.bound}`).join(" ")}]`);

    console.log(`first-load budget: firstScreenAssetsGzipBytes=${firstScreen.total} (baseline ${baseline.firstScreenAssetsGzipBytes}) [${firstScreen.perAsset.join(" ")}]`);
    console.log(`first-load budget: deferredAssetsGzipBytes=${deferred.total} (baseline ${baseline.deferredAssetsGzipBytes}) [${deferred.perAsset.join(" ")}]`);
    console.log(`first-load budget: issue414ComparisonGzipBytes=${issue414.total} (baseline ${baseline.issue414ComparisonGzipBytes}) [${issue414.perAsset.join(" ")}]`);
    console.log(`first-load budget: shellEagerRawBytes=${shellRaw} (baseline ${baseline.shellEagerRawBytes})`);

    assert.ok(
      firstScreen.total <= baseline.firstScreenAssetsGzipBytes,
      `first-screen gzip bytes regressed: ${firstScreen.total} > ${baseline.firstScreenAssetsGzipBytes}; shrink the payload or re-measure and lower the baseline in the same commit`,
    );
    assert.ok(
      deferred.total <= baseline.deferredAssetsGzipBytes,
      `deferred bundle gzip bytes regressed: ${deferred.total} > ${baseline.deferredAssetsGzipBytes}; shrink the payload or re-measure and lower the baseline in the same commit`,
    );
    // The coordinator's original five-asset set keeps its own bound: the two larger bundles may
    // leave the critical path, but their bytes must not grow either.
    assert.ok(
      issue414.total <= baseline.issue414ComparisonGzipBytes,
      `the #414 five-asset gzip total regressed: ${issue414.total} > ${baseline.issue414ComparisonGzipBytes}; shrink the payload or re-measure and lower the baseline in the same commit`,
    );
    assert.ok(
      shellRaw <= baseline.shellEagerRawBytes,
      `shell eager raw bytes regressed: ${shellRaw} > ${baseline.shellEagerRawBytes}; shrink the payload or re-measure and lower the baseline in the same commit`,
    );
  });
});
