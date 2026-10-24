// Offline guards for the Phase 1-F font-token gate (issue #361).
//
// The bounded Chromium gate (`scripts/render-parity-phase1-font.mjs`) owns the
// computed-style proof that `.preview` and `.cm-editor` take their font family
// from the theme's `--font-text` chain. These fast checks keep the pinned
// expectations bound to the files that declare them, and keep the gate able to
// fail:
//
//   1. the fixture still declares the exact lists the gate pins, and binds
//      `--font-text-theme` to the text sentinel;
//   2. app.css still declares the default chain the default pass pins — the
//      alias `--font-text: var(--font-text-override, var(--font-text-theme))`,
//      the fallback interface list, the `.preview` font shorthand — and the
//      CodeMirror editor theme still consumes `var(--font-text)`;
//   3. the fixture's text list and interface list are DIFFERENT, so the gate can
//      tell "the host consumed --font-text" from "the host inherited the body
//      font". app.css's own defaults alias the two, so this is a real property
//      of the fixture, not of the app;
//   4. a replacement of any pinned list is RED for `validateFontFixture`;
//   5. the negative control moves all three lists and all three expectations;
//   6. the gate pins both required hosts, requires them to own the consuming
//      declaration, and the Chromium job wires the gate;
//   7. the body-only fixture carries the same sentinels as the root fixture but
//      declares them ONLY on `body` — the shape a `:root`-only alias cannot see.
//      The root feature keeps that shape (a theme token at `:root`), while the
//      body feature adds the documented-Obsidian shape (a token on `body`).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mutateFontFixture, validateAppFallback, validateFontFixture } from "../scripts/render-parity-phase1-font.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(appRoot, relative), "utf8").replace(/\r\n/g, "\n");

const FIXTURE = "test/fixtures/render-parity-font-fixture.css";
const BODY_FIXTURE = "test/fixtures/render-parity-font-fixture-body.css";
const APP_CSS = "src/app/assets/app.css";
const GATE = "scripts/render-parity-phase1-font.mjs";
const TEXT_LIST = '"RenderParity Text Alpha", "RenderParity Text Beta", serif';
const UI_LIST = '"RenderParity UI Alpha", "RenderParity UI Beta", sans-serif';
const MONO_LIST = '"RenderParity Mono Alpha", monospace';

const fixture = read(FIXTURE);
const bodyFixture = read(BODY_FIXTURE);
const appCss = read(APP_CSS);
const gate = read(GATE);

test("the font fixture declares every pinned list the gate asserts", () => {
  assert.deepEqual(validateFontFixture(fixture), []);
  assert.ok(fixture.includes(TEXT_LIST));
  assert.ok(fixture.includes(UI_LIST));
  assert.ok(fixture.includes(MONO_LIST));
  assert.match(fixture, /--font-text-theme:\s*"RenderParity Text Alpha"/);
  // The two document-host / interface lists must stay distinguishable: with the
  // app's own defaults they alias each other, so a same-valued fixture could not
  // fail when a host stops consuming --font-text.
  assert.notEqual(TEXT_LIST, UI_LIST);
});

test("app.css and the editor theme still consume the --font-text chain", () => {
  assert.deepEqual(validateAppFallback(appCss), []);
  assert.ok(appCss.includes("--font-text: var(--font-text-override, var(--font-text-theme));"));
  assert.ok(appCss.includes("--font-text-theme: var(--font-interface-theme);"));
  assert.ok(appCss.includes("font: var(--font-text-size, 16px)/var(--line-height-normal, 1.5) var(--font-text);"));
  // #361 product fix: the resolved aliases are redeclared at `body` scope, so a
  // community theme that declares its font tokens on `body` (Obsidian's
  // documented "build a theme" shape) is seen by the document hosts. The
  // browser gate's body pass is the behavioural guard; this pins the declaration
  // so a refactor cannot silently drop it.
  assert.match(
    appCss.replace(/\s+/g, " "),
    /body \{ --font-interface: var\(--font-interface-override, var\(--font-interface-theme\)\); --font-text: var\(--font-text-override, var\(--font-text-theme\)\); --font-monospace: var\(--font-monospace-override, var\(--font-monospace-theme\)\); \}/,
    "app.css must redeclare the resolved font aliases at body scope",
  );
  const editorTheme = read("frontend/app/features/editor/extensions/theme.js");
  assert.ok(editorTheme.includes('fontFamily: "var(--font-text)"'), "the CodeMirror theme must consume --font-text");
});

test("a pinned list replaced by a fake value is RED", () => {
  // The gate's expectations are the fixture's own declarations: once the file
  // declares something else, validation fails and the gate cannot go green by
  // comparing a computed value to itself.
  const tampered = fixture.replace(TEXT_LIST, '"RenderParity Text Fake", serif');
  const problems = validateFontFixture(tampered);
  assert.ok(problems.length >= 1, "a replaced list must fail fixture validation");
  assert.ok(problems.some((entry) => entry.includes("does not declare")), problems.join("; "));
  // The negative-control fixture is exactly that case, and it is allowed to run
  // only because the control pass asserts the MUTATED list instead.
  const mutated = mutateFontFixture(fixture);
  assert.ok(validateFontFixture(mutated.css).length >= 3, "the control fixture must not satisfy the pinned lists");
});

test("the negative control moves every list and every expectation", () => {
  const mutated = mutateFontFixture(fixture);
  assert.equal(mutated.mutations, 3, "all three lists must move");
  assert.notEqual(mutated.css, fixture);
  for (const value of [mutated.expected.text, mutated.expected.ui, mutated.expected.mono]) {
    assert.ok(mutated.css.includes(value), `${value} must be declared by the mutated fixture`);
  }
  for (const stale of [TEXT_LIST, UI_LIST, MONO_LIST]) assert.ok(!mutated.css.includes(stale), `${stale} must be gone`);
  // Idempotent: mutating an already-mutated fixture changes nothing further.
  assert.equal(mutateFontFixture(mutated.css).mutations, 0);
});

test("the body-only font fixture declares the same tokens ONLY on body", () => {
  // Same sentinels as the root fixture, so the same pinned expectations and the
  // same mutation control apply; the selector scope is the only difference.
  assert.deepEqual(validateFontFixture(bodyFixture), []);
  const css = bodyFixture.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /(^|\n)body\s*\{/);
  // No `:root` / `.theme-light` / `.theme-dark` declaration: that is exactly the
  // scope a root-shaped alias resolves at, so a root-shaped fixture cannot fail
  // on a body-scoped theme token.
  assert.ok(!/:root|\.theme-light|\.theme-dark/.test(css), "the body fixture must declare its tokens only on body");
  for (const value of [TEXT_LIST, UI_LIST, MONO_LIST]) {
    assert.ok(fixture.includes(value), `the root fixture must still declare ${value}`);
    assert.ok(bodyFixture.includes(value), `the body fixture must declare ${value}`);
  }
  // The mutation control must work on the body fixture too, or the new pass
  // could never prove it followed the theme rather than the app fallback.
  const mutated = mutateFontFixture(bodyFixture);
  assert.equal(mutated.mutations, 3);
  assert.ok(!mutated.css.includes(TEXT_LIST), "the body control must move the text list");
});

test("the gate pins both document hosts and requires them to consume the token", () => {
  assert.match(gate, /const THEME_TOKEN = "--font-text";/);
  assert.match(gate, /\{ id: "preview", selector: "\.preview", token: THEME_TOKEN, requiresOwnDeclaration: true \}/);
  assert.match(gate, /\{ id: "cm-editor", selector: "\.cm-editor", token: THEME_TOKEN, requiresOwnDeclaration: true \}/);
  // The consumption check must match `var(--font-text)` and `var(--font-text, x)`
  // but not the unrelated `--font-text-size` / `--font-text-override` tokens.
  assert.ok(gate.includes(String.raw`var\(\s*--font-text\s*[,)]`), "the token consumption check must be exact");
  assert.match(gate, /validateFontFixture\(fixtureCss\)/);
  assert.match(gate, /validateAppFallback\(appCss\)/);
  assert.match(gate, /mutateFontFixture\(fixtureCss\)/);
  // The body-only scenario is wired next to the root one and is not a
  // replacement: both fixtures are read and asserted.
  assert.match(gate, /render-parity-font-fixture-body\.css/);
  assert.match(gate, /BODY_THEME_NAME|MUTATED_BODY_THEME_NAME/);
  assert.match(gate, /validateFontFixture\(bodyFixtureCss\)/);
  assert.match(gate, /report\.passes\.readerBodyTheme = await assertPass\(\{ page, label: "body-theme\/reader"/);
  assert.match(gate, /report\.passes\.liveBodyTheme = await assertPass\(\{ page, label: "body-theme\/live"/);
  assert.match(gate, /report\.bodyControl = /);
  assert.match(gate, /body negative control did not follow the mutated theme/);
});

test("the Chromium job wires the font gate and uploads its artifacts", () => {
  const ci = fs.readFileSync(path.resolve(appRoot, "..", ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /node scripts\/render-parity-phase1-font\.mjs/);
  assert.match(ci, /name: render-parity-phase1-font/);
  assert.match(ci, /RENDER_PARITY_OUTPUT: \$\{\{ runner\.temp \}\}\/render-parity-font/);
});
