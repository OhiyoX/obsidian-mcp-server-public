import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { after } from "node:test";
import express from "express";
import { listenFetchSafeOrigin } from "../../scripts/fetch-safe-listen.mjs";
import { w3DataPath, assertW3DataPath, cleanupW3DataPath } from "./vault-w3-data-path.js";

after(cleanupW3DataPath);
// The data-path module has finished binding before these config consumers load.
const { createAdminRouter } = await import("../../src/admin/router.js");
const { createVaultCompositionRoot } = await import("../../src/vault-runtime/vault-composition-root.js");
const { createVaultRegistry } = await import("../../src/vault-runtime/registry.js");
const { createVaultServingGate } = await import("../../src/vault-runtime/serving-gate.js");
const { createVaultAdmissionController } = await import("../../src/app/vault-admission.js");
const { createVaultAdmissionAdminBinding } = await import("../../src/app/vault-admission-admin-binding.js");
const { primaryAuthorized } = await import("../../src/vault-runtime/primary-authorization.js");

export const TAB = "/admin/auth/vault-git";
export async function managedAdmin(t, { initialized = true, automaticDiscovery = true } = {}) {
  assertW3DataPath();
  const temp = path.join(w3DataPath, "w3-return");
  await fs.mkdir(temp, { recursive: true });
  const base = await fs.mkdtemp(path.join(temp, "http-"));
  // Install cleanup before the first failable enrollment/write.
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const primaryRoot = path.join(base, "primary");
  const vaultsRoot = path.join(base, "vaults");
  await fs.mkdir(primaryRoot); await fs.mkdir(path.join(base, "data"));
  await fs.mkdir(path.join(vaultsRoot, "alpha"), { recursive: true });
  let controller;
  let scanHold = null;
  const heldScans = new Set();
  const fsApi = { ...fs, async opendir(...args) {
    const hold = scanHold; scanHold = null;
    if (hold) { hold.enter(); await hold.wait; heldScans.delete(hold); }
    return fs.opendir(...args);
  } };
  const servingGate = createVaultServingGate();
  const registry = createVaultRegistry({ primaryRoot, primaryId: "vault", vaultsRoot,
    servingGate, fsApi, gate: descriptor => controller.gate(descriptor) });
  controller = createVaultAdmissionController({ registry,
    file: path.join(base, "data", "vault-admissions.json"), automaticDiscovery,
    logger: { warn() {} } });
  await controller.load();
  const primaryRuntime = { id: "vault", root: primaryRoot, primary: true, localFs: {} };
  const root = createVaultCompositionRoot({ registry, primaryRuntime, primaryRoot,
    dataRoot: path.join(base, "data"), writable: true, admission: createVaultAdmissionAdminBinding(controller) });
  const service = controller.install({ runtimeMap: root.vaultRuntimeMap });
  if (initialized) await controller.initialize({ confirm: ["alpha"], actor: "admin:fixture", source: "fixture" });
  else await controller.reconcile("startup");
  const app = express();
  const password = randomBytes(24).toString("hex");
  app.use("/admin/auth", createAdminRouter({ adminPassword: password, secureCookie: false,
    provider: { ready: Promise.resolve(), recordAudit() {}, async authorizationSnapshot() {
      return { oauthUsers: [], clients: [], apiKeys: [], tokens: [], audit: [] };
    } }, vaultGitAdmin: root.vaultGitAdmin }));
  // Port 0 can choose a fetch-forbidden port on Windows; `listenFetchSafeOrigin`
  // retries behind the scenes (WHATWG/Node fetch blocked ports, issue #344).
  const server = http.createServer(app);
  const origin = await listenFetchSafeOrigin(server);
  t.after(async () => {
    for (const hold of heldScans) hold.release();
    await new Promise(resolve => server.close(resolve)); service.stop();
    root.vaultRuntimeMap.dispose(); await root.vaultRuntimeMap.settleRetirements();
    await fs.rm(base, { recursive: true, force: true });
  });
  const login = await fetch(`${origin}/admin/auth/login`, { method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ password }) });
  assert.equal(login.status, 303);
  const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  async function request(route = TAB, fields = null, { csrf, authenticated = true } = {}) {
    if (fields && csrf === undefined) {
      const page = await request(); csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1];
      assert.ok(csrf, "real page CSRF required");
    }
    const form = fields ? new URLSearchParams() : null;
    if (form) {
      for (const [key, value] of Object.entries({ ...fields, csrf })) {
        for (const item of Array.isArray(value) ? value : [value]) form.append(key, item);
      }
    }
    const response = await fetch(`${origin}${route}`, { method: fields ? "POST" : "GET", redirect: "manual",
      headers: { ...(authenticated ? { cookie } : {}), ...(fields ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      body: form });
    const body = await response.text();
    return { response, body };
  }
  return { ...root, registry, controller, service, request, base, origin, sessionCookie: cookie,
    vaultsRoot, primaryRoot,
    primaryAuthorized, async beta() { await fs.mkdir(path.join(vaultsRoot, "beta")); },
    holdNextScan() {
      let enter, release;
      const started = new Promise(resolve => { enter = resolve; });
      const wait = new Promise(resolve => { release = resolve; });
      const hold = { enter, release, wait }; heldScans.add(hold); scanHold = hold;
      return { started, release };
    } };
}

export function httpEvidence(route, result, csrf = "valid session token (redacted)") {
  const { response, body } = result;
  console.log(`REQUEST POST ${route} CSRF=${csrf}\nHTTP/1.1 ${response.status} ${response.statusText}\nContent-Type: ${response.headers.get("content-type")}`);
  if (response.headers.has("location")) console.log(`Location: ${response.headers.get("location")}`);
  // Response-body excerpts only: never log session cookies or hidden CSRF values.
  console.log(`BODY EXCERPTS: ${body.match(/<code>(?:vault_git_|VAULT_)[^<]+<\/code>|CSRF 校验失败[^<]*|Vault 清单已刷新[^<]*|准入操作已完成[^<]*|准入决定已保存[^<]*|统一刷新已合并[^<]*/g)?.join("\n") ?? "(page rendered)"}`);
}
