import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  initializePublishThemeToggle,
  publishThemeToggleView,
} from "../frontend/app/features/publish/theme-toggle.js";

function fakeTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type, handler) { if (listeners.get(type) === handler) listeners.delete(type); },
    fire(type) { listeners.get(type)?.(); },
  };
}

function fakeButton() {
  const target = fakeTarget();
  const attrs = new Map();
  const label = { textContent: "" };
  return {
    ...target,
    title: "",
    querySelector(selector) {
      if (selector === "[data-publish-theme-label]") return label;
      return null;
    },
    setAttribute(key, value) { attrs.set(key, String(value)); },
    read() {
      return {
        title: this.title,
        ariaLabel: attrs.get("aria-label"),
        targetMode: attrs.get("data-target-mode"),
        label: label.textContent,
      };
    },
  };
}

test("Publish theme toggle advertises the target mode", () => {
  assert.deepEqual(publishThemeToggleView(false), {
    targetMode: "dark",
    label: "深色模式",
    title: "切换到深色模式",
  });
  assert.deepEqual(publishThemeToggleView(true), {
    targetMode: "light",
    label: "浅色模式",
    title: "切换到浅色模式",
  });
});

test("Publish theme toggle switches mode without rewriting icon references", () => {
  const button = fakeButton();
  const eventTarget = fakeTarget();
  let dark = false;
  const theme = {
    isDark: () => dark,
    toggle() { dark = !dark; },
  };

  const dispose = initializePublishThemeToggle({ button, theme, eventTarget });
  assert.deepEqual(button.read(), {
    title: "切换到深色模式",
    ariaLabel: "切换到深色模式",
    targetMode: "dark",
    label: "深色模式",
  });

  button.fire("click");
  assert.equal(dark, true);
  assert.deepEqual(button.read(), {
    title: "切换到浅色模式",
    ariaLabel: "切换到浅色模式",
    targetMode: "light",
    label: "浅色模式",
  });

  dark = false;
  eventTarget.fire("obsidian-theme-change");
  assert.equal(button.read().targetMode, "dark");
  assert.equal(button.read().label, "深色模式");

  dispose();
});

test("Publish page keeps moon and sun mounted in one fixed icon slot", async () => {
  const [pages, css, source] = await Promise.all([
    fs.readFile(new URL("../src/app/pages.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/app/assets/publish.css", import.meta.url), "utf8"),
    fs.readFile(new URL("../frontend/app/features/publish/theme-toggle.js", import.meta.url), "utf8"),
  ]);

  assert.match(pages, /publish-theme-icon-slot/);
  assert.match(pages, /publish-theme-icon-moon[^>]*>[\s\S]*?#moon/);
  assert.match(pages, /publish-theme-icon-sun[^>]*>[\s\S]*?#sun/);
  assert.match(css, /:root\.theme-light \.publish-theme-icon-moon \{ opacity: 1; \}/);
  assert.match(css, /:root\.theme-dark \.publish-theme-icon-sun \{ opacity: 1; \}/);
  assert.doesNotMatch(source, /setAttribute\(["']href["']/);
});


test("Publish mobile theme toggle hides only its text label", async () => {
  const css = await fs.readFile(new URL("../src/app/assets/publish.css", import.meta.url), "utf8");

  assert.match(css, /@media \(max-width: 640px\)[\s\S]*?\.publish-theme-toggle \[data-publish-theme-label\] \{ display: none; \}/);
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*?\.publish-theme-toggle \{[\s\S]*?width: 34px;[\s\S]*?height: 34px;[\s\S]*?justify-content: center;/);
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*?\.publish-theme-icon-slot \{ display: block; \}/);
  assert.doesNotMatch(css, /\.publish-theme-toggle span \{ display: none; \}/);
});


test("Publish reader forwards the public document title instead of rendering the placeholder source path", async () => {
  const source = await fs.readFile(new URL("../frontend/app/publish.js", import.meta.url), "utf8");

  assert.match(source, /function safePublicHtml\(markdown, title\)/);
  assert.match(source, /renderObsidianMarkdown\(markdown, \{ sourcePath: "published\.md", vaultId: "published", title \}\)/);
  assert.match(source, /safePublicHtml\(String\(payload\.content \|\| ""\), String\(payload\.title \|\| ""\)\)/);
});
