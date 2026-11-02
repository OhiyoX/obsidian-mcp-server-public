import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const [pages, themeBoot, login] = await Promise.all([
  fs.readFile(new URL("../src/app/pages.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../src/app/assets/theme-boot.js", import.meta.url), "utf8").then((source) => source.replace(/\r\n?/g, "\n")),
  fs.readFile(new URL("../src/app/assets/login.js", import.meta.url), "utf8"),
]);

test("login, workspace and Publish expose browser theme-color metadata", () => {
  assert.equal([...pages.matchAll(/<meta name="theme-color" content="#ffffff">/g)].length, 3);
  const loginScript = pages.indexOf('<script src="${assetUrl("login.js")}"></script>');
  const loginStyles = pages.indexOf('<link rel="stylesheet" href="${assetUrl("reader.css")}">');
  assert.ok(loginScript >= 0 && loginScript < loginStyles, "login theme bootstrap should run before CSS paint");
});

test("shared theme bootstrap keeps browser chrome aligned with rendered theme", () => {
  assert.match(themeBoot, /DEFAULT_THEME_COLORS = Object\.freeze\(\{ light: "#ffffff", dark: "#212121" \}\)/);
  assert.match(themeBoot, /meta\[name="theme-color"\]/);
  assert.match(themeBoot, /document\.querySelector\("\.workspace"\) \|\| document\.body/);
  assert.match(themeBoot, /new MutationObserver\(\(\) => syncBrowserThemeColor\(\)\)/);
  assert.match(themeBoot, /#community-theme/);
  assert.match(themeBoot, /window\.addEventListener\?\.\("load", \(\) => syncBrowserThemeColor\(\)/);
  assert.match(themeBoot, /syncBrowserThemeColor,\n\};/);
});

test("login bootstrap updates browser chrome for light, dark and system changes", () => {
  assert.match(login, /meta\[name="theme-color"\]/);
  assert.match(login, /document\.querySelector\("\.login-page"\) \|\| document\.body/);
  assert.match(login, /syncBrowserThemeColor\(dark\)/);
  assert.match(login, /window\.addEventListener\?\.\("load", \(\) => syncBrowserThemeColor/);
  assert.match(login, /media\.addEventListener\?\.\("change"/);
});
