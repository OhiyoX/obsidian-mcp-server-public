import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { formatBeijingDeployLabel, renderSettingsDeployTime } from "../frontend/app/features/settings/deploy-time.js";

const dataDir = mkdtempSync(path.join(tmpdir(), "settings-deploy-time-"));
process.env.DATA_PATH = dataDir;
process.env.MCP_SERVER_VERSION = "0.0.0-local";
const { appPage } = await import("../src/app/pages.js");

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

test("formatBeijingDeployLabel converts a UTC instant to a fixed +08:00 label", () => {
  assert.equal(formatBeijingDeployLabel("2026-10-10T04:40:07Z"), "北京时间 · 2026-10-10 12:40:07 +08:00");
  assert.equal(formatBeijingDeployLabel("2026-10-10T11:37:33Z"), "北京时间 · 2026-10-10 19:37:33 +08:00");
  assert.equal(formatBeijingDeployLabel("2026-10-10T16:30:00Z"), "北京时间 · 2026-10-11 00:30:00 +08:00");
});

test("formatBeijingDeployLabel leaves missing and unusable timestamps alone", () => {
  assert.equal(formatBeijingDeployLabel(null), null);
  assert.equal(formatBeijingDeployLabel(""), null);
  assert.equal(formatBeijingDeployLabel("not-a-timestamp"), null);
  assert.equal(formatBeijingDeployLabel(123), null);
});

function deployNode(iso) {
  const node = {
    text: "服务端时间 · 2026-10-10 04:40:07 +00:00",
    getAttribute(name) {
      return name === "data-deployed-at" ? iso : null;
    },
    set textContent(value) {
      this.text = value;
    },
  };
  return {
    node,
    querySelector(selector) {
      return selector === ".settings-meta-deploy" ? node : null;
    },
  };
}

test("renderSettingsDeployTime replaces only a parseable deploy line", () => {
  const root = deployNode("2026-10-10T11:37:33Z");
  assert.equal(renderSettingsDeployTime(root), "北京时间 · 2026-10-10 19:37:33 +08:00");
  assert.equal(root.node.text, "北京时间 · 2026-10-10 19:37:33 +08:00");

  const untouched = deployNode(null);
  assert.equal(renderSettingsDeployTime(untouched), null);
  assert.equal(untouched.node.text, "服务端时间 · 2026-10-10 04:40:07 +00:00");
});

test("the settings shell keeps the server clock and hands the raw ISO to the browser", () => {
  writeFileSync(path.join(dataDir, "deployed-version.json"), JSON.stringify({
    version: "v2026.10.10.5",
    commit: "d55f9f4c102f562090fbadcc319ead14e8cdd24f",
    deployedAt: "2026-10-10T11:37:33Z",
  }));
  const html = appPage({ csrf: "csrf", username: "tester", displayName: "Tester" }, {});
  const start = html.indexOf('class="settings-meta"');
  const footer = html.slice(start, html.indexOf("</footer>", start));
  assert.match(footer, /data-deployed-at="2026-10-10T11:37:33Z"/);
  assert.match(footer, /服务端时间 · /);
  assert.doesNotMatch(footer, /北京时间/);
});
