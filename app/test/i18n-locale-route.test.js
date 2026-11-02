// The interface-language switch route and the per-request locale decision.
//
// This is the only writer of the preference cookie, so its boundaries are pinned:
// it may store exactly the shipped locales (or clear the cookie for "follow the
// browser"), it never returns a reader off-origin, and it never echoes an
// unsupported tag into the cookie.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { once } from "node:events";
import { registerLocaleRoutes, safeLocaleNext } from "../src/app/locale-routes.js";
import { localeInfo } from "../src/i18n/request.js";
import { LOCALE_COOKIE } from "../src/i18n/index.js";

async function withServer(run) {
  const app = express();
  registerLocaleRoutes(app, { secureCookie: false });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("a supported language is stored and the reader is sent back", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/app/language?lang=en&next=/app/note/abc`, { redirect: "manual" });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/app/note/abc");
    const cookie = response.headers.getSetCookie().join("; ");
    assert.match(cookie, new RegExp(`${LOCALE_COOKIE}=en`));
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /Max-Age=31536000/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
  });
});

test("follow-the-browser clears the stored preference", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/app/language?lang=auto&next=/app/`, { redirect: "manual" });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/app/");
    const cookie = response.headers.getSetCookie().join("; ");
    assert.match(cookie, new RegExp(`${LOCALE_COOKIE}=;`));
    assert.match(cookie, /Expires=Thu, 01 Jan 1970/);
  });
});

test("an unsupported tag changes nothing but still returns the reader", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/app/language?lang=de&next=/app/`, { redirect: "manual" });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/app/");
    assert.deepEqual(response.headers.getSetCookie(), []);
  });
});

test("the return target comes from the Referer when no next is given", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/app/language?lang=en`, { redirect: "manual", headers: { referer: `${base}/app/note/xyz?x=1` } });
    assert.equal(response.headers.get("location"), "/app/note/xyz?x=1");
  });
});

test("off-origin or non-page targets degrade to the app root", async () => {
  await withServer(async (base) => {
    for (const query of ["next=//evil.example/app/", "next=https://evil.example/app/", "next=/admin/keys", "next=/api/web/v1/session", "next=javascript:alert(1)"]) {
      const response = await fetch(`${base}/app/language?lang=en&${query}`, { redirect: "manual" });
      assert.equal(response.headers.get("location"), "/app/", query);
    }
    const evilReferer = await fetch(`${base}/app/language?lang=en`, { redirect: "manual", headers: { referer: "https://evil.example/app/" } });
    assert.equal(evilReferer.headers.get("location"), "/app/", "a cross-origin Referer is not a return target");
  });
});

test("safeLocaleNext keeps app, login, publish and admin paths only", () => {
  assert.equal(safeLocaleNext("/app/"), "/app/");
  assert.equal(safeLocaleNext("/app"), "/app");
  assert.equal(safeLocaleNext("/app/note/a%20b?x=1"), "/app/note/a%20b?x=1");
  assert.equal(safeLocaleNext("/auth/login?next=%2Fapp%2F"), "/auth/login?next=%2Fapp%2F");
  assert.equal(safeLocaleNext("/publish/abc"), "/publish/abc");
  // One preference serves both planes: the Admin shell is a valid return target.
  assert.equal(safeLocaleNext("/admin/auth"), "/admin/auth");
  assert.equal(safeLocaleNext("/admin/auth?tab=keys"), "/admin/auth?tab=keys");
  for (const bad of ["", null, undefined, "//evil.example/app/", "https://evil.example/app/", "/appx", "/admin/keys", "/admin/authx", "/admin/", "/app/../admin", "\\\\evil\\app", "/app/\r\nSet-Cookie: x=1"]) {
    assert.equal(safeLocaleNext(bad), null, String(bad));
  }
});

test("localeInfo resolves the render locale and the stored preference separately", () => {
  assert.deepEqual(localeInfo({ headers: {} }), { locale: "zh-CN", preference: null });
  assert.deepEqual(localeInfo({ headers: { "accept-language": "en-US,en;q=0.9" } }), { locale: "zh-CN", preference: null }, "an English browser without a stored choice still gets the default face");
  assert.deepEqual(localeInfo({ headers: { cookie: `${LOCALE_COOKIE}=en` } }), { locale: "en", preference: "en" });
  assert.deepEqual(localeInfo({ headers: { cookie: `${LOCALE_COOKIE}=auto`, "accept-language": "en-GB,en;q=0.9" } }), { locale: "en", preference: "auto" });
  assert.deepEqual(localeInfo({ query: { lang: "en" }, headers: { cookie: `${LOCALE_COOKIE}=zh-CN` } }), { locale: "en", preference: "zh-CN" });
  assert.deepEqual(localeInfo({ query: { lang: "de" }, headers: { cookie: `${LOCALE_COOKIE}=en` } }), { locale: "en", preference: "en" });
  assert.deepEqual(localeInfo({ query: { lang: ["en", "zh-CN"] }, headers: {} }), { locale: "en", preference: null });
});
