// usage: node cdp-shot.mjs out.png width height scale mobile(0/1) "query#hash" [jsBeforeShot]
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [out, w, h, scale, mobile, q, js] = process.argv.slice(2);
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn("google-chrome", ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`, "--user-data-dir=" + path.join((await import("node:os")).tmpdir(), "cdp-" + port), "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ver;
for (let i = 0; i < 50; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (ver.length) break; } catch {} await sleep(150); }
const page = ver.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Page.enable"); await send("Runtime.enable"); ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.method === "Runtime.exceptionThrown") console.error("PAGE ERROR", JSON.stringify(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text)); });
await send("Emulation.setDeviceMetricsOverride", { width: +w, height: +h, deviceScaleFactor: +scale, mobile: mobile === "1" });
if (mobile === "1") await send("Emulation.setTouchEmulationEnabled", { enabled: true });
await send("Page.navigate", { url: pathToFileURL(path.join(ROOT, "index.html")).href + (q || "") });
await sleep(900);
if (js) { const r = await send("Runtime.evaluate", { expression: js, awaitPromise: true }); if (r.result?.exceptionDetails) console.error(JSON.stringify(r.result.exceptionDetails)); else if (r.result?.result?.value !== undefined) console.log("eval:", r.result.result.value); await sleep(700); }
const errs = await send("Runtime.evaluate", { expression: "document.documentElement.scrollWidth + 'x' + innerWidth" });
console.log(out, "scrollWidth x innerWidth =", errs.result.result.value);
const shot = await send("Page.captureScreenshot", { format: "png" });
(await import("node:fs")).writeFileSync(out.startsWith("/") ? out : path.join(ROOT, "screenshots", out), Buffer.from(shot.result.data, "base64"));
ws.close(); chrome.kill();
process.exit(0);
