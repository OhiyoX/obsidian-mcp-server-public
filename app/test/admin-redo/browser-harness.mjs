// Browser harness for the Admin-plane client tests (lane L3 infra, used by
// `client-lists.test.js`). Real Chromium over the DevTools protocol with no dependency to install:
// the protocol client is Node's built-in `WebSocket`, and the browser binary comes from the
// repository's own pinned resolver (`scripts/web-regression/chromium-binary.mjs`, issue #380 — full
// Chrome for Testing only, never the headless shell, fail-closed when neither exists).
//
// Everything an Admin client test needs: connect, open a page target, navigate, and drive real input
// (typing, clicking, keys, select changes) that also works with script execution disabled.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ChromiumBinaryError, resolveChromiumExecutable } from "../../scripts/web-regression/chromium-binary.mjs";

/** Expression helper: call a page function with JSON-serialised arguments, return its value. */
export function js(fn, ...args) {
  return `(${fn.toString()})(${args.map((value) => JSON.stringify(value)).join(", ")})`;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One WebSocket to the browser endpoint; commands carry the flat-session `sessionId`. */
export class Cdp {
  constructor(socket) {
    Object.assign(this, { socket, id: 1, pending: new Map(), waiters: new Map() });
    socket.addEventListener("message", (event) => this.#receive(String(event.data)));
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error(`cannot open ${url}`)), { once: true });
    });
    return new Cdp(socket);
  }

  #receive(raw) {
    const message = JSON.parse(raw);
    if (!message.id) {
      const key = `${message.sessionId ?? ""}|${message.method}`;
      for (const waiter of [...(this.waiters.get(key) ?? [])]) waiter(message.params);
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
    else entry.resolve(message.result);
  }

  send(method, params = {}, sessionId = null) {
    const id = this.id++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    this.socket.send(JSON.stringify(message));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  waitFor(method, sessionId = null, timeoutMs = 20000) {
    const key = `${sessionId ?? ""}|${method}`;
    return new Promise((resolve, reject) => {
      const drop = () => this.waiters.set(key, (this.waiters.get(key) ?? []).filter((entry) => entry !== onEvent));
      const timer = setTimeout(() => { drop(); reject(new Error(`timed out waiting for ${method}`)); }, timeoutMs);
      const onEvent = (params) => { clearTimeout(timer); drop(); resolve(params); };
      this.waiters.set(key, [...(this.waiters.get(key) ?? []), onEvent]);
    });
  }

  close() {
    try { this.socket.close(); } catch { /* already gone */ }
  }
}

export class Page {
  constructor(cdp, targetId, sessionId, origin) {
    Object.assign(this, { cdp, targetId, sessionId, origin });
  }

  send(method, params = {}) {
    return this.cdp.send(method, params, this.sessionId);
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(`evaluate failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result.value;
  }

  async goto(url) {
    const loaded = this.cdp.waitFor("Page.loadEventFired", this.sessionId);
    await this.send("Page.navigate", { url: `${this.origin}${url}` });
    await loaded;
  }

  async nodeId(selector) {
    const { root } = await this.send("DOM.getDocument", { depth: 1 });
    const { nodeId } = await this.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    assert.ok(nodeId, `selector not found in the page: ${selector}`);
    return nodeId;
  }

  /** Focus + click through the browser's own input pipeline (works with script disabled too). */
  async focus(selector) {
    await this.send("DOM.focus", { nodeId: await this.nodeId(selector) });
  }

  async click(selector) {
    const nodeId = await this.nodeId(selector);
    // The page scrolls inside `.content`, not the window, so the element must be brought into the
    // viewport first; `getBoxModel` then reports viewport coordinates.
    await this.send("DOM.scrollIntoViewIfNeeded", { nodeId });
    const { model } = await this.send("DOM.getBoxModel", { nodeId });
    const [x1, y1, , , x3, y3] = model.content;
    const x = (x1 + x3) / 2;
    const y = (y1 + y3) / 2;
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  }

  /** Real typing: `Input.insertText` runs through the browser's editing pipeline, character by character. */
  async type(text) {
    for (const character of String(text)) await this.send("Input.insertText", { text: character });
  }

  async pressKey(key, code, virtualKeyCode, modifiers = 0) {
    const common = { key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode, modifiers };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...common });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
  }

  async backspaces(count) {
    for (let index = 0; index < count; index += 1) await this.pressKey("Backspace", "Backspace", 8);
  }

  /** `⌘/Ctrl+Enter` with the modifier the shell's key router listens for. */
  ctrlEnter() {
    return this.pressKey("Enter", "Enter", 13, 2);
  }

  /** Change a `<select>` the way a user does (focus + ArrowDown), not by assigning `.value`. */
  async selectNext(selector, steps = 1) {
    await this.focus(selector);
    for (let index = 0; index < steps; index += 1) await this.pressKey("ArrowDown", "ArrowDown", 40);
  }

  setScriptExecutionDisabled(value) {
    return this.send("Emulation.setScriptExecutionDisabled", { value });
  }

  mobile(value) {
    return value
      ? this.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
      : this.send("Emulation.clearDeviceMetricsOverride");
  }

  block(urls) {
    return this.send("Network.setBlockedURLs", { urls });
  }
}

function browsersPath() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === "win32") return path.join(os.homedir(), "AppData", "Local", "ms-playwright");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  return path.join(os.homedir(), ".cache", "ms-playwright");
}

/** `{ executablePath }` or `{ error }` — never a headless-shell build (issue #380). */
export function resolveBrowser() {
  try {
    const { executablePath } = resolveChromiumExecutable({ override: process.env.CHROMIUM_EXECUTABLE || "", browsersPath: browsersPath() });
    return { executablePath };
  } catch (error) {
    if (!(error instanceof ChromiumBinaryError)) throw error;
    return { error: error.message };
  }
}

/** Launch headless Chromium and wait for its own `DevTools listening on …` line. */
export async function launchBrowser(executablePath) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "l3-lists-chromium-"));
  const child = spawn(executablePath, [
    // See `client-overlays.test.js` (#602): the CI runner image is root and Chromium refuses to
    // start there without `--no-sandbox` (crbug.com/638180). This mirrors the default the
    // Playwright-driven harnesses in this repository already run with (`chromiumSandbox: false`).
    "--no-sandbox",
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-background-networking", "--disable-sync", "--mute-audio",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`chromium did not report a DevTools endpoint: ${output}`)), 30000);
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`chromium exited early (${code}): ${output}`)); });
  });
  return { child, profile, endpoint };
}
