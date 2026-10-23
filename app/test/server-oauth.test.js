import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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

// Stop the spawned server without ever hanging the suite. Registering the exit
// listener before kill() prevents a missed exit when the child already died
// (for example a failed dependency load), and the SIGKILL escalation keeps a
// stalled graceful shutdown from blocking the whole test run on any platform.
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    let escalate;
    const finish = () => {
      clearTimeout(escalate);
      resolve();
    };
    child.once("exit", finish);
    escalate = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, 5000);
    escalate.unref?.();
    child.kill();
  });
}

async function waitFor(url, child, output) {
  // Full-suite crypto/index tests can briefly saturate slower NAS-class CPUs.
  for (let attempt = 0; attempt < 450; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited early with code ${child.exitCode}: ${output.join("")}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for OAuth server: ${output.join("")}`);
}

async function rpc(url, key, method, params, session, id = 10, extraHeaders = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(key ? { "X-API-Key": key } : {}), ...(session ? { "Mcp-Session-Id": session } : {}), ...extraHeaders },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  const payload = response.headers.get("content-type")?.includes("event-stream")
    ? body.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((item) => item.id === id)
    : JSON.parse(body);
  assert.ok(payload && !payload.error);
  return { result: payload.result, session: response.headers.get("mcp-session-id") || session };
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  try { return JSON.parse(text); } catch { throw new Error(`Expected JSON from ${url}, got ${response.status}: ${text.slice(0, 240)}`); }
}

test("HTTP server exposes OAuth discovery and challenges unauthenticated MCP requests", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-server-oauth-"));
  const port = await freePort();
  await fs.mkdir(path.join(root, "vault"), { recursive: true });
  await fs.mkdir(path.join(root, "vaults", "research"), { recursive: true });
  await fs.writeFile(path.join(root, "vaults", "research", "Scoped.md"), "# Scoped publication", "utf8");
  await fs.mkdir(path.join(root, "vault", ".obsidian", "themes", "Things", "fonts"), { recursive: true });
  await fs.writeFile(path.join(root, "vault", ".obsidian", "themes", "Things", "manifest.json"), JSON.stringify({ name: "Things", version: "2.1.20", minAppVersion: "1.0.0", author: "Theme Author" }));
  await fs.writeFile(path.join(root, "vault", ".obsidian", "themes", "Things", "theme.css"), '.theme-light{--color-base-00:#fff}.theme-dark{--color-base-00:#111}@font-face{font-family:"Theme";src:url("fonts/theme.woff2")}');
  await fs.writeFile(path.join(root, "vault", ".obsidian", "themes", "Standalone.css"), ".theme-light{--color-base-00:#eee}");
  await fs.writeFile(path.join(root, "vault", ".obsidian", "themes", "Things", "fonts", "theme.woff2"), Buffer.from([0, 1, 2, 3]));
  await fs.writeFile(path.join(root, "vault", ".obsidian", "appearance.json"), JSON.stringify({ theme: "obsidian", cssTheme: "Things", baseFontSize: 17 }));
  await fs.mkdir(path.join(root, "vault", "web", "images"), { recursive: true });
  await fs.writeFile(path.join(root, "vault", "web", "images", "pixel.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  await fs.writeFile(path.join(root, "vault", "Published.md"), "---\nsecret: admin-must-not-render\n---\n# Published body", "utf8");
  const readableNote = "_Workspace/40-Projects/example/guide.md";
  await fs.mkdir(path.dirname(path.join(root, "vault", readableNote)), { recursive: true });
  await fs.writeFile(path.join(root, "vault", readableNote), "# Readable deep link\n", "utf8");
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      VAULT_PATH: path.join(root, "vault"),
      WEB_VAULTS_ROOT: path.join(root, "vaults"),
      WEB_DEFAULT_VAULT: "vault",
      DATA_PATH: path.join(root, "data"),
      OAUTH_ENABLED: "true",
      PUBLIC_BASE_URL: `http://localhost:${port}`,
      OAUTH_ADMIN_PASSWORD: "test-only-password",
      OAUTH_INITIAL_USERNAME: "test-owner",
      OAUTH_INITIAL_PASSWORD: "test-oauth-password",
      // Production has two explicitly trusted ingress peers: the Docker gateway
      // and the FRP client host. Keep a multi-address value covered here so the
      // client address from X-Forwarded-For is not collapsed to the FRP peer.
      TRUST_PROXY: "127.0.0.1, 10.0.0.55",
      API_KEY: "",
      GIT_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  try {
    await waitFor(`http://127.0.0.1:${port}/healthz`, child, output);
    const protectedMetadata = await fetchJson(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`);
    const authorizationMetadata = await fetchJson(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`);
    assert.equal(protectedMetadata.resource, `http://localhost:${port}/mcp`);
    assert.equal(authorizationMetadata.issuer, `http://localhost:${port}/`);
    assert.equal(authorizationMetadata.code_challenge_methods_supported[0], "S256");
    assert.equal(authorizationMetadata.authorization_endpoint, `http://localhost:${port}/oauth/authorize`);
    assert.equal(authorizationMetadata.token_endpoint, `http://localhost:${port}/oauth/token`);
    assert.equal(authorizationMetadata.registration_endpoint, `http://localhost:${port}/oauth/register`);
    assert.equal(authorizationMetadata.revocation_endpoint, `http://localhost:${port}/oauth/revoke`);
    const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.7" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
    });
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get("www-authenticate"), /oauth-protected-resource\/mcp/);
    assert.match(unauthorized.headers.get("www-authenticate"), /scope="obsidian\.read obsidian\.write obsidian\.files"/);
    const anonymousWeb = await fetch(`http://127.0.0.1:${port}/app`, { redirect: "manual" });
    assert.equal(anonymousWeb.status, 303);
    assert.equal(anonymousWeb.headers.get("location"), "/auth/login");
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/web/v1/notes`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/web/v1/events`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/web/v1/themes`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/web/v1/asset?path=web/images/pixel.png`)).status, 401);
    const loginPageResponse = await fetch(`http://127.0.0.1:${port}/auth/login`);
    assert.equal(loginPageResponse.status, 200);
    const loginHtml = await loginPageResponse.text();
    assert.match(loginHtml, /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg">/);

    const faviconResponse = await fetch(`http://127.0.0.1:${port}/favicon.svg`);
    assert.equal(faviconResponse.status, 200);
    assert.match(faviconResponse.headers.get("content-type") || "", /^image\/svg\+xml/);
    assert.match(await faviconResponse.text(), /<svg\b/);
    assert.match(loginHtml, /class="theme-dark"/);
    assert.match(loginHtml, /data-color-mode="dark"/);
    assert.match(loginHtml, /\/auth\/theme\.css\?name=Things/);
    assert.match(loginHtml, /\/app\/assets\/login\.js/);
    const loginTheme = await fetch(`http://127.0.0.1:${port}/auth/theme.css?name=Things`);
    assert.equal(loginTheme.status, 200);
    assert.match(await loginTheme.text(), /\/auth\/theme-asset\?name=Things/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/auth/theme.css?name=Other`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "test-owner", password: "incorrect-password" }),
    })).status, 403);
    const webLogin = await fetch(`http://127.0.0.1:${port}/auth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "test-owner", password: "test-oauth-password" }),
    });
    assert.equal(webLogin.status, 303);
    assert.equal(webLogin.headers.get("location"), "/app/");
    const webCookie = webLogin.headers.get("set-cookie").split(";", 1)[0];
    const readableUrl = `/app/note/${readableNote.replace(/\.md$/, "").split("/").map(encodeURIComponent).join("/")}`;
    const anonymousReadable = await fetch(`http://127.0.0.1:${port}${readableUrl}`, { redirect: "manual" });
    assert.equal(anonymousReadable.status, 303);
    assert.match(anonymousReadable.headers.get("location"), /^\/auth\/login\?next=/);
    const readableResponse = await fetch(`http://127.0.0.1:${port}${readableUrl}`, {
      headers: { Cookie: webCookie }, redirect: "manual",
    });
    assert.equal(readableResponse.status, 302);
    const canonicalNoteRoute = readableResponse.headers.get("location");
    assert.match(canonicalNoteRoute, /^\/app\/note\/[A-Za-z0-9_-]+$/);
    const canonicalResponse = await fetch(`http://127.0.0.1:${port}${canonicalNoteRoute}`, { headers: { Cookie: webCookie } });
    assert.equal(canonicalResponse.status, 200);
    assert.match(await canonicalResponse.text(), /Readable deep link|guide/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/app/note/_Workspace/40-Projects/missing`, {
      headers: { Cookie: webCookie }, redirect: "manual",
    })).status, 404);
    const webCannotAdmin = await fetch(`http://127.0.0.1:${port}/admin/auth`, { headers: { Cookie: webCookie }, redirect: "manual" });
    assert.equal(webCannotAdmin.status, 303);
    assert.equal(webCannotAdmin.headers.get("location"), "/admin/auth/login");
    assert.equal((await fetch(`http://127.0.0.1:${port}/mcp`, { headers: { Cookie: webCookie } })).status, 401);
    assert.match(webCookie, /^obsidian_web_session=/);
    const webPage = await fetch(`http://127.0.0.1:${port}/app`, { headers: { Cookie: webCookie } });
    const webHtml = await webPage.text();
    assert.match(webHtml, /class="theme-dark"/);
    assert.match(webHtml, /data-color-mode="dark"/);
    assert.match(webHtml, /\/api\/web\/v1\/theme\.css\?name=Things/);
    assert.match(webHtml, /\/app\/assets\/theme-boot\.js/);
    assert.match(webHtml, /id="vault-select"/);
    assert.match(webHtml, /data-mode="live"/);
    assert.match(webHtml, /data-mode="raw"/);
    assert.match(webHtml, /\/app\/assets\/app\.js/);
    assert.match(webHtml, /id="files-toggle"/);
    assert.match(webHtml, /id="community-theme"/);
    assert.match(webHtml, /id="theme-select"/);
    assert.match(webHtml, /id="color-mode"/);
    assert.doesNotMatch(webHtml, /id="outline-toggle"|data-document-outline/);
    assert.match(webHtml, /id="outline-list"/);
    assert.match(webHtml, /class="sidebar-footer"/);
    assert.match(webHtml, /id="left-pane-resizer"/);
    assert.match(webHtml, /id="right-pane-resizer"/);
    assert.match(webHtml, /id="live-status"/);
    assert.match(webHtml, /id="semantic-search"/);
    // U10 + #398: copy-link / Publish are ⋮ menu items (the outline item was removed).
    assert.match(webHtml, /data-document-link[\s\S]*data-publish-toggle/);
    assert.match(webHtml, /class="view-mode topbar-view-mode"/);
    assert.match(webHtml, /Obsidian 搜索语法/);
    assert.match(webHtml, /markdown-reading-view/);
    const webCss = await (await fetch(`http://127.0.0.1:${port}/app/assets/app.css`)).text();
    const webJs = await (await fetch(`http://127.0.0.1:${port}/app/assets/app.js`)).text();
    const editorJs = await (await fetch(`http://127.0.0.1:${port}/app/assets/editor.js`)).text();
    const readerJs = await (await fetch(`http://127.0.0.1:${port}/app/assets/reader.js`)).text();
    const readerCss = await (await fetch(`http://127.0.0.1:${port}/app/assets/reader.css`)).text();
    const iconSprite = await (await fetch(`http://127.0.0.1:${port}/app/assets/icons.svg`)).text();
    assert.match(webCss, /--font-interface:/);
    assert.match(webCss, /\.tree-folder/);
    assert.match(webCss, /\.shell\.sidebar-hidden/);
    assert.match(webCss, /\.preview \.tag/);
    assert.match(webCss, /\.outline-item/);
    assert.match(webCss, /\.outline-children/);
    assert.match(webCss, /--left-pane-width/);
    assert.match(webCss, /\.cm-live-property-pills \.cm-live-property-pill-remove/);
    assert.match(webCss, /\.select-control/);
    assert.match(webCss, /min-width: 44px/);
    assert.doesNotMatch(webCss, /\.status-bar/);
    assert.match(webCss, /100dvh/);
    assert.match(webJs, /files-toggle/);
    assert.doesNotMatch(webJs, /outline-toggle/);
    assert.match(webJs, /outline-collapse/);
    assert.match(editorJs, /createObsidianEditor/);
    assert.match(editorJs, /cm-lineNumbers/);
    assert.match(readerJs, /renderObsidianMarkdown/);
    assert.match(readerCss, /KaTeX_Main/);
    assert.match(iconSprite, /id="list-tree"/);
    assert.match(iconSprite, /id="tag"/);
    assert.match(iconSprite, /id="chevron-down"/);
    assert.doesNotMatch(webJs, /\/api\/web\/v1\/render/);
    assert.match(webJs, /obsidian-web\.color-mode/);
    const vaultInventoryResponse = await fetch(`http://127.0.0.1:${port}/api/web/v1/vaults`, { headers: { Cookie: webCookie } });
    const vaultInventoryText = await vaultInventoryResponse.text();
    assert.equal(vaultInventoryResponse.status, 200, vaultInventoryText);
    const vaultInventory = JSON.parse(vaultInventoryText);
    assert.equal(vaultInventory.current, "vault");
    assert.deepEqual(vaultInventory.vaults.map((item) => item.id), ["vault"]);
    assert.equal(vaultInventory.canCreate, true);
    const webCsrf = webHtml.match(/name="csrf-token" content="([^"]+)"/)[1];
    const publishResponse = await fetch(`http://127.0.0.1:${port}/api/web/v1/publish`, {
      method: "POST",
      headers: { Cookie: webCookie, "Content-Type": "application/json", "X-CSRF-Token": webCsrf },
      body: JSON.stringify({ action: "publish", path: "Published.md" }),
    });
    assert.equal(publishResponse.status, 200);
    const publishData = await publishResponse.json();
    assert.equal(publishData.published, true);
    assert.match(publishData.privateUrl, new RegExp(`^http://localhost:${port}/app/note/`));
    const privateNote = await fetch(`http://127.0.0.1:${port}${publishData.privatePath}`, { headers: { Cookie: webCookie } });
    assert.equal(privateNote.status, 200);
    assert.match(publishData.publicUrl, new RegExp(`^http://localhost:${port}/publish/`));
    const publicNote = await fetch(`http://127.0.0.1:${port}${publishData.publicPath}`);
    const publicNoteHtml = await publicNote.text();
    assert.equal(publicNote.status, 200);
    assert.match(publicNoteHtml, /Published body/);
    assert.doesNotMatch(publicNoteHtml, /admin-must-not-render/);
    const themes = await fetchJson(`http://127.0.0.1:${port}/api/web/v1/themes`, { headers: { Cookie: webCookie } });
    assert.equal(themes.defaultTheme, "Things");
    assert.deepEqual(themes.appearance, { themeId: "Things", colorMode: "dark", baseFontSize: 17 });
    assert.equal(themes.themes.length, 1);
    assert.deepEqual(themes.themes[0].modes, ["light", "dark"]);
    assert.equal(Object.hasOwn(themes.themes[0], "legacy"), false);
    const themeCssResponse = await fetch(`http://127.0.0.1:${port}/api/web/v1/theme.css?name=Things`, { headers: { Cookie: webCookie } });
    assert.equal(themeCssResponse.headers.get("content-type"), "text/css; charset=utf-8");
    const themeCss = await themeCssResponse.text();
    assert.match(themeCss, /theme-dark/);
    assert.match(themeCss, /\/api\/web\/v1\/theme-asset\?name=Things&path=fonts%2Ftheme\.woff2/);
    const themeAsset = await fetch(`http://127.0.0.1:${port}/api/web/v1/theme-asset?name=Things&path=fonts%2Ftheme.woff2`, { headers: { Cookie: webCookie } });
    assert.equal(themeAsset.status, 200);
    const attachment = await fetch(`http://127.0.0.1:${port}/api/web/v1/asset?path=pixel.png&from=web%2Fcore.md`, { headers: { Cookie: webCookie } });
    assert.equal(attachment.status, 200);
    assert.equal(attachment.headers.get("content-type"), "image/png");
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/web/v1/asset?path=..%2F.obsidian%2Fthemes%2FThings%2Ftheme.css&from=web%2Fcore.md`, { headers: { Cookie: webCookie } })).status, 400);
    const webCreated = await fetch(`http://127.0.0.1:${port}/api/web/v1/note`, {
      method: "POST",
      headers: { Cookie: webCookie, "Content-Type": "application/json", "X-CSRF-Token": webCsrf },
      body: JSON.stringify({ path: "web/core.md", content: "---\ntags: [project/search]\nstatus: active\n---\n# Web core\n\nFirst revision.\n\n## API\nalpha and beta share this line.\n\n## UI\nSemantic controls.\n" }),
    });
    assert.equal(webCreated.status, 200);
    const createdWebNote = await webCreated.json();
    assert.equal(createdWebNote.created, true);
    const webList = await fetchJson(`http://127.0.0.1:${port}/api/web/v1/notes?q=Web%20core`, { headers: { Cookie: webCookie } });
    assert.equal(webList.notes[0].path, "web/core.md");
    for (const query of ["path:web", "file:core", "tag:project", 'line:"alpha and beta"', 'section:"Semantic controls"', "[status:active]", "file:missing OR tag:project", "tag:project -obsolete"]) {
      const result = await fetchJson(`http://127.0.0.1:${port}/api/web/v1/notes?q=${encodeURIComponent(query)}`, { headers: { Cookie: webCookie } });
      assert.equal(result.notes[0]?.path, "web/core.md", query);
    }
    const hybridSearch = await fetchJson(`http://127.0.0.1:${port}/api/web/v1/notes?q=${encodeURIComponent("tag:project Semantic")}&semantic=true`, { headers: { Cookie: webCookie } });
    assert.equal(hybridSearch.notes[0]?.path, "web/core.md");
    assert.equal(hybridSearch.semanticRequested, true);
    assert.equal(typeof hybridSearch.semanticUsed, "boolean");
    assert.equal(hybridSearch.hybridUsed, true);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/web/v1/notes?q=${encodeURIComponent('file:"broken')}`, { headers: { Cookie: webCookie } })).status, 400);
    const webReadResponse = await fetch(`http://127.0.0.1:${port}/api/web/v1/note?path=web%2Fcore.md`, { headers: { Cookie: webCookie } });
    const webRead = await webReadResponse.json();
    assert.match(webRead.content, /First revision/);
    assert.equal(webReadResponse.headers.get("etag"), `"${webRead.revision}"`);
    const notModified = await fetch(`http://127.0.0.1:${port}/api/web/v1/note?path=web%2Fcore.md`, { headers: { Cookie: webCookie, "If-None-Match": `"${webRead.revision}"` } });
    assert.equal(notModified.status, 304);
    const webUpdated = await fetch(`http://127.0.0.1:${port}/api/web/v1/note`, {
      method: "POST",
      headers: { Cookie: webCookie, "Content-Type": "application/json", "X-CSRF-Token": webCsrf },
      body: JSON.stringify({ path: "web/core.md", content: "# Web core\n\nSecond revision.\n", ifMatch: webRead.revision }),
    });
    assert.equal(webUpdated.status, 200);
    const staleUpdate = await fetch(`http://127.0.0.1:${port}/api/web/v1/note`, {
      method: "POST",
      headers: { Cookie: webCookie, "Content-Type": "application/json", "X-CSRF-Token": webCsrf },
      body: JSON.stringify({ path: "web/core.md", content: "stale", ifMatch: webRead.revision }),
    });
    assert.equal(staleUpdate.status, 409);
    const webLogout = await fetch(`http://127.0.0.1:${port}/auth/logout`, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: webCookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: webCsrf }),
    });
    assert.equal(webLogout.status, 303);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/web/v1/notes`, { headers: { Cookie: webCookie } })).status, 401);
    const callback = `http://127.0.0.1:${port}/callback`;
    const registered = await (await fetch(`http://127.0.0.1:${port}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.8" },
      body: JSON.stringify({ client_name: "OAuth HTTP test", redirect_uris: [callback], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    })).json();
    const verifier = "oauth-http-test-verifier-that-is-long-enough-for-pkce-123456789";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorizeUrl = new URL(`http://127.0.0.1:${port}/oauth/authorize`);
    authorizeUrl.search = new URLSearchParams({ response_type: "code", client_id: registered.client_id, redirect_uri: callback, code_challenge: challenge, code_challenge_method: "S256", state: "oauth-test-state", resource: `http://localhost:${port}/mcp`, scope: "obsidian.read obsidian.write obsidian.files" });
    const consent = await fetch(authorizeUrl, { headers: { "X-Forwarded-For": "198.51.100.8" } });
    const consentHtml = await consent.text();
    assert.match(consentHtml, /OAuth 账户/);
    assert.equal((consentHtml.match(/name="scope"/g) || []).length, 3);
    const transaction = consentHtml.match(/name="transaction" value="([^"]+)"/)[1];
    const approvalBody = new URLSearchParams({ transaction, username: "test-owner", password: "test-oauth-password", decision: "allow" });
    for (const scope of ["obsidian.read", "obsidian.write", "obsidian.files"]) approvalBody.append("scope", scope);
    const approved = await fetch(`http://127.0.0.1:${port}/oauth/decision`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "198.51.100.8" },
      body: approvalBody,
    });
    assert.equal(approved.status, 302);
    const authorizationCode = new URL(approved.headers.get("location")).searchParams.get("code");
    const tokenResponse = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "198.51.100.8" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: registered.client_id, code: authorizationCode, code_verifier: verifier, redirect_uri: callback, resource: `http://localhost:${port}/mcp` }),
    });
    assert.equal(tokenResponse.status, 200);
    const oauthTokens = await tokenResponse.json();
    assert.equal(oauthTokens.scope, "obsidian.read obsidian.write obsidian.files");
    const oauthInit = await rpc(`http://127.0.0.1:${port}/mcp`, null, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "oauth-test", version: "1" } }, undefined, 3, { Authorization: `Bearer ${oauthTokens.access_token}` });
    await rpc(`http://127.0.0.1:${port}/mcp`, null, "tools/call", { name: "write_note", arguments: { path: "oauth-full-scope.md", content: "full scope", frontmatter: { status: "active", tags: ["mcp/search"] }, overwrite: false } }, oauthInit.session, 4, { Authorization: `Bearer ${oauthTokens.access_token}` });
    assert.match(await fs.readFile(path.join(root, "vault", "oauth-full-scope.md"), "utf8"), /full scope/);
    await fs.mkdir(path.join(root, "data", "trash", "oauth-plan"), { recursive: true });
    await fs.writeFile(path.join(root, "data", "trash", "oauth-plan", "preview.md"), "planned preview\n");
    const plannedTrash = await rpc(`http://127.0.0.1:${port}/mcp`, null, "tools/call", {
      name: "plan_restore_from_trash", arguments: { backupPath: "oauth-plan/preview.md", destination: "oauth-preview.md" },
    }, oauthInit.session, 42, { Authorization: `Bearer ${oauthTokens.access_token}` });
    assert.equal(plannedTrash.result.isError, undefined);
    assert.equal(plannedTrash.result.structuredContent.changed, true);
    await assert.rejects(fs.access(path.join(root, "vault", "oauth-preview.md")));
    const mcpSearch = await rpc(`http://127.0.0.1:${port}/mcp`, null, "tools/call", { name: "search_notes", arguments: { query: 'file:oauth-full-scope tag:mcp [status:active] "full scope"', semantic: true } }, oauthInit.session, 41, { Authorization: `Bearer ${oauthTokens.access_token}` });
    assert.equal(mcpSearch.result.structuredContent.results[0]?.path, "oauth-full-scope.md");
    assert.equal(mcpSearch.result.structuredContent.semanticRequested, true);
    assert.equal(typeof mcpSearch.result.structuredContent.semanticUsed, "boolean");
    assert.equal(mcpSearch.result.structuredContent.hybridUsed, true);

    const refreshedResponse = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "198.51.100.8" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: registered.client_id,
        refresh_token: oauthTokens.refresh_token,
        resource: `http://localhost:${port}/mcp`,
        scope: "obsidian.read obsidian.write obsidian.files",
      }),
    });
    assert.equal(refreshedResponse.status, 200);
    const refreshedTokens = await refreshedResponse.json();
    const samePrincipalAfterRefresh = await rpc(
      `http://127.0.0.1:${port}/mcp`,
      null,
      "tools/list",
      {},
      oauthInit.session,
      43,
      { Authorization: `Bearer ${refreshedTokens.access_token}` },
    );
    assert.ok(samePrincipalAfterRefresh.result.tools.some((tool) => tool.name === "get_note"));

    const readVerifier = "oauth-read-only-verifier-123456789012345678901234567890";
    const readChallenge = createHash("sha256").update(readVerifier).digest("base64url");
    const readAuthorizeUrl = new URL(`http://127.0.0.1:${port}/authorize`);
    readAuthorizeUrl.search = new URLSearchParams({ response_type: "code", client_id: registered.client_id, redirect_uri: callback, code_challenge: readChallenge, code_challenge_method: "S256", state: "oauth-read-only", resource: `http://localhost:${port}/mcp`, scope: "obsidian.read" });
    const readAuthorization = await fetch(readAuthorizeUrl, { headers: { "X-Forwarded-For": "198.51.100.8" } });
    assert.equal(readAuthorization.status, 200);
    const readTransaction = (await readAuthorization.text()).match(/name="transaction" value="([^"]+)"/)[1];
    const readApproval = await fetch(`http://127.0.0.1:${port}/oauth/decision`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "198.51.100.8" },
      body: new URLSearchParams({ transaction: readTransaction, username: "test-owner", password: "test-oauth-password", scope: "obsidian.read", decision: "allow" }),
    });
    assert.equal(readApproval.status, 302);
    const readCode = new URL(readApproval.headers.get("location")).searchParams.get("code");
    const readTokenResponse = await fetch(`http://127.0.0.1:${port}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "198.51.100.8" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: registered.client_id, code: readCode, code_verifier: readVerifier, redirect_uri: callback, resource: `http://localhost:${port}/mcp` }),
    });
    assert.equal(readTokenResponse.status, 200);
    const readTokens = await readTokenResponse.json();
    assert.equal(readTokens.scope, "obsidian.read");
    const readOauthInit = await rpc(`http://127.0.0.1:${port}/mcp`, null, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "oauth-read-only", version: "1" } }, undefined, 5, { Authorization: `Bearer ${readTokens.access_token}` });
    const oauthWriteDenied = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${readTokens.access_token}`, "Mcp-Session-Id": readOauthInit.session },
      body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "write_note", arguments: { path: "oauth-read-only-must-not-exist.md", content: "denied", overwrite: false } } }),
    });
    assert.equal(oauthWriteDenied.status, 403);
    assert.equal((await oauthWriteDenied.json()).error, "insufficient_scope");
    await assert.rejects(fs.access(path.join(root, "vault", "oauth-read-only-must-not-exist.md")));
    assert.equal((await fetch(`http://127.0.0.1:${port}/authorize`)).status, 400);
    for (const compatibilityPath of ["/token", "/register", "/revoke"]) {
      assert.equal((await fetch(`http://127.0.0.1:${port}${compatibilityPath}`, { method: "POST" })).status, 400);
    }
    const legacyAdmin = await fetch(`http://127.0.0.1:${port}/admin`, { redirect: "manual" });
    assert.equal(legacyAdmin.status, 302);
    assert.equal(legacyAdmin.headers.get("location"), "/admin/auth");
    const login = await fetch(`http://127.0.0.1:${port}/admin/auth/login`);
    assert.equal(login.status, 200);
    assert.match(login.headers.get("content-security-policy") || "", /img-src 'self'/);
    assert.match(await login.text(), /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg">/);
    const authenticated = await fetch(`http://127.0.0.1:${port}/admin/auth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "test-only-password" }),
    });
    assert.equal(authenticated.status, 303);
    const cookie = authenticated.headers.get("set-cookie").split(";", 1)[0];
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/web/v1/notes`, { headers: { Cookie: cookie } })).status, 401);
    const adminPage = await fetch(`http://127.0.0.1:${port}/admin/auth`, { headers: { Cookie: cookie } });
    const adminHtml = await adminPage.text();
    assert.match(adminHtml, /<div class="app" data-tab="[a-z-]+"><aside class="side" id="admin-nav">/, "the Admin plane renders the prototype app shell"); // data-tab = the approved D0 hook; id="admin-nav" = the Q10 aria-controls target
    assert.match(adminHtml, /<nav class="side-body scroll" aria-label="授权管理">/, "the sidebar keeps the prototype nav");
    assert.match(adminHtml, /--font:\s*Inter/);
    const csrf = adminHtml.match(/name="csrf" value="([^"]+)"/)[1];

    // One public OAuth client may be authorized by multiple local accounts.
    // An MCP session must remain bound to the account/credential principal
    // that initialized it, not merely to the shared OAuth client_id.
    const createSecondUser = await fetch(`http://127.0.0.1:${port}/admin/auth/oauth/user/create`, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrf,
        username: "second-owner",
        displayName: "Second Owner",
        password: "second-oauth-password",
        allowedScope: "obsidian.read",
        allowedVault: "vault",
      }),
    });
    assert.equal(createSecondUser.status, 303);

    const secondVerifier = "oauth-second-user-verifier-123456789012345678901234567890";
    const secondChallenge = createHash("sha256").update(secondVerifier).digest("base64url");
    const secondAuthorizeUrl = new URL(`http://127.0.0.1:${port}/oauth/authorize`);
    secondAuthorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: registered.client_id,
      redirect_uri: callback,
      code_challenge: secondChallenge,
      code_challenge_method: "S256",
      state: "oauth-second-user",
      resource: `http://localhost:${port}/mcp`,
      scope: "obsidian.read",
    });
    const secondAuthorization = await fetch(secondAuthorizeUrl, { headers: { "X-Forwarded-For": "198.51.100.9" } });
    assert.equal(secondAuthorization.status, 200);
    const secondTransaction = (await secondAuthorization.text()).match(/name="transaction" value="([^"]+)"/)[1];
    const secondApproval = await fetch(`http://127.0.0.1:${port}/oauth/decision`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "198.51.100.9" },
      body: new URLSearchParams({
        transaction: secondTransaction,
        username: "second-owner",
        password: "second-oauth-password",
        scope: "obsidian.read",
        decision: "allow",
      }),
    });
    assert.equal(secondApproval.status, 302);
    const secondCode = new URL(secondApproval.headers.get("location")).searchParams.get("code");
    const secondTokenResponse = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "198.51.100.9" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: registered.client_id,
        code: secondCode,
        code_verifier: secondVerifier,
        redirect_uri: callback,
        resource: `http://localhost:${port}/mcp`,
      }),
    });
    assert.equal(secondTokenResponse.status, 200);
    const secondTokens = await secondTokenResponse.json();

    const crossPrincipalSession = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${secondTokens.access_token}`,
        "Mcp-Session-Id": oauthInit.session,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 61, method: "tools/list", params: {} }),
    });
    assert.equal(crossPrincipalSession.status, 403);
    assert.match(await crossPrincipalSession.text(), /different authenticated principal/);

    for (const method of ["GET", "DELETE"]) {
      const crossPrincipalTransport = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method,
        headers: {
          Authorization: `Bearer ${secondTokens.access_token}`,
          "Mcp-Session-Id": oauthInit.session,
        },
      });
      assert.equal(crossPrincipalTransport.status, 403, method);
      assert.match(await crossPrincipalTransport.text(), /different authenticated principal/, method);
    }

    assert.match(adminHtml, /已发布文档|发布文档/);
    const publishesPage = await fetch(`http://127.0.0.1:${port}/admin/auth?tab=publishes`, { headers: { Cookie: cookie } });
    const publishesHtml = await publishesPage.text();
    assert.match(publishesHtml, /Published\.md/);
    assert.match(publishesHtml, new RegExp(`/publish/${publishData.publicPath.split('/').at(-1)}`));
    assert.doesNotMatch(publishesHtml, /admin-must-not-render/);
    const adminRevokePublish = await fetch(`http://127.0.0.1:${port}/admin/auth/publish/revoke`, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, id: publishData.publicPath.split('/').at(-1) }),
    });
    assert.equal(adminRevokePublish.status, 303);
    assert.match(adminRevokePublish.headers.get("location"), /tab=publishes/);
    assert.equal((await fetch(`http://127.0.0.1:${port}${publishData.publicPath}`)).status, 404);
    const accountPage = await fetch(`http://127.0.0.1:${port}/admin/auth?tab=accounts`, { headers: { Cookie: cookie } });
    const accountHtml = await accountPage.text();
    assert.match(accountHtml, /OAuth 账户/);
    assert.match(accountHtml, /test-owner/);
    // W3 Option B: authorized clients are name links (proto), not count spans.
    // Authorized clients are name links (proto accounts row), not count spans: one cell per account.
    const linkedClientCells = [...accountHtml.matchAll(/<td class="cellt"><a href="\/admin\/auth\?tab=clients&amp;id=[^"]+">[^<]+<\/a>(?:、<a href="\/admin\/auth\?tab=clients&amp;id=[^"]+">[^<]+<\/a>)*<\/td>/g)];
    assert.equal(linkedClientCells.length, 2, "each account links its authorized client by name, never a count");
    // The prototype sheet's own `translateX` (switch knob, off-screen drawer) is not page markup.
    assert.doesNotMatch(accountHtml.slice(accountHtml.indexOf("<body>")), /translateX\(/);
    assert.match(accountHtml, /198\.51\.100\.8/);
    const accountCreatePage = await fetch(`http://127.0.0.1:${port}/admin/auth?tab=accounts&id=new`, { headers: { Cookie: cookie } });
    const accountCreateHtml = await accountCreatePage.text();
    assert.match(accountCreateHtml, /<form id="new-account" method="post" action="\/admin\/auth\/oauth\/user\/create">/);
    assert.match(accountCreateHtml, /name="allowedScope"/); assert.match(accountCreateHtml, /name="allowedVault"/);
    assert.match(accountCreateHtml, /class="chk"/); assert.match(accountCreateHtml, /新建账户/);
    const clientsPage = await fetch(`http://127.0.0.1:${port}/admin/auth?tab=clients`, { headers: { Cookie: cookie } });
    const clientsHtml = await clientsPage.text();
    // The domain cell lists the recorded sources (proto `来源：注册、授权、调用`), never a guess.
    assert.match(clientsHtml, /连接域名/);
    assert.match(clientsHtml, new RegExp(`localhost:${port}`));
    assert.match(clientsHtml, /title="来源：[^"]*注册/);
    assert.match(clientsHtml, /title="来源：[^"]*(?:授权|调用|请求)/);
    assert.match(clientsHtml, /<th>已授权账户<\/th>/);
    assert.match(clientsHtml, /域名来自实际授权(?: resource 与 MCP 调用|与调用)/);
    // Proto clients row: the one 已授权账户 cell links both accounts' own drawers, not a count.
    assert.equal([...clientsHtml.matchAll(/<td class="cellt"><a href="\/admin\/auth\?tab=accounts&amp;id=[^"]+">(?:Second Owner|test-owner)<\/a>(?:、<a href="\/admin\/auth\?tab=accounts&amp;id=[^"]+">(?:Second Owner|test-owner)<\/a>)*<\/td>/g)].length, 1, "both authorizing accounts share the cell, each as a link");
    const auditPage = await fetch(`http://127.0.0.1:${port}/admin/auth?tab=audit&outcome=success&action=oauth&origin=localhost&pageSize=25&page=1`, { headers: { Cookie: cookie } });
    const auditHtml = await auditPage.text();
    assert.match(auditHtml, /class="toolbar"/);
    assert.match(auditHtml, /name="pageSize"/);
    assert.match(auditHtml, /class="seg"[\s\S]{0,400}outcome=(?:success|failure)/, "the outcome filter is the prototype's segmented links");
    assert.match(auditHtml, /name="origin"[^>]*value="localhost"/); assert.match(auditHtml, new RegExp(`localhost:${port}`));
    // Agent attribution is owned by `audit-attribution-http.test.js`; this file keeps the filters.
    assert.match(auditHtml, /<th>Agent<\/th>/);
    assert.match(auditHtml, /href="\/app\/"[\s\S]*?进入 Obsidian Web/);
    const tokenPage = await fetch(`http://127.0.0.1:${port}/admin/auth?tab=tokens&order=asc`, { headers: { Cookie: cookie } });
    const tokenHtml = await tokenPage.text();
    assert.match(tokenHtml, /href="[^"]*confirm=token-cleanup/, "the cleanup entrance is a GET into the confirm state");
    assert.match(tokenHtml, /value="asc" selected/); assert.match(tokenHtml, /绑定域名/);
    assert.match(tokenHtml, new RegExp(`localhost:${port}`));
    // `清理历史记录…` is a GET into its own confirm page, which carries the `olderThanDays` field.
    const cleanupHtml = await (await fetch(`http://127.0.0.1:${port}/admin/auth?tab=tokens&order=asc&confirm=token-cleanup&days=30`, { headers: { Cookie: cookie } })).text();
    assert.match(cleanupHtml, /action="\/admin\/auth\/oauth\/token\/cleanup"/);
    assert.match(cleanupHtml, /name="olderThanDays" value="30"/);
    const cleanup = await fetch(`http://127.0.0.1:${port}/admin/auth/oauth/token/cleanup`, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, olderThanDays: "0" }),
    });
    assert.equal(cleanup.status, 303);
    assert.match(cleanup.headers.get("location"), /tab=tokens/);
    const createKey = await fetch(`http://127.0.0.1:${port}/admin/auth/api-key/create`, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, label: "HTTP integration test" }),
    });
    assert.equal(createKey.status, 303);
    const keyPage = await fetch(`http://127.0.0.1:${port}/admin/auth`, { headers: { Cookie: cookie } });
    const managedKey = (await keyPage.text()).match(/obmcp_[0-9a-f]{12}_[A-Za-z0-9_-]+/)[0];
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/web/v1/notes`, { headers: { "X-API-Key": managedKey } })).status, 401);

    const apiKeyAgainstOAuthSession = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "X-API-Key": managedKey,
        "Mcp-Session-Id": oauthInit.session,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 62, method: "tools/list", params: {} }),
    });
    assert.equal(apiKeyAgainstOAuthSession.status, 403);
    assert.match(await apiKeyAgainstOAuthSession.text(), /different authenticated principal/);
    for (const method of ["GET", "DELETE"]) {
      const apiKeyCrossTransport = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method,
        headers: { "X-API-Key": managedKey, "Mcp-Session-Id": oauthInit.session },
      });
      assert.equal(apiKeyCrossTransport.status, 403, method);
      assert.match(await apiKeyCrossTransport.text(), /different authenticated principal/, method);
    }
    const managedAuth = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-API-Key": managedKey },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "managed-key-test", version: "1" } } }),
    });
    assert.equal(managedAuth.status, 200);
    const firstSession = managedAuth.headers.get("mcp-session-id");
    await managedAuth.arrayBuffer();
    const started = await rpc(`http://127.0.0.1:${port}/mcp`, managedKey, "tools/call", { name: "start_file_upload", arguments: { path: "attachments/reconnect.bin", totalBytes: 4 } }, firstSession, 11);
    const uploadId = started.result.structuredContent.uploadId;
    const secondInit = await rpc(`http://127.0.0.1:${port}/mcp`, managedKey, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "managed-key-test", version: "2" } }, undefined, 12);
    const listed = await rpc(`http://127.0.0.1:${port}/mcp`, managedKey, "tools/list", {}, secondInit.session, 13);
    const appendDescriptor = listed.result.tools.find((tool) => tool.name === "append_to_note");
    assert.deepEqual(appendDescriptor.outputSchema.required, ["path", "created", "previousSizeInBytes", "currentSizeInBytes", "revision", "preWriteVersionId"]);
    assert.deepEqual(appendDescriptor.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    const indexDefault = await rpc(`http://127.0.0.1:${port}/mcp`, managedKey, "tools/call", { name: "index_status", arguments: {} }, secondInit.session, 131);
    assert.ok(indexDefault.result.structuredContent, JSON.stringify(indexDefault.result));
    assert.equal(typeof indexDefault.result.structuredContent.version, "number");
    const indexLocal = await rpc(`http://127.0.0.1:${port}/mcp`, managedKey, "tools/call", { name: "index_status", arguments: { checkRemote: false } }, secondInit.session, 132);
    assert.equal(indexLocal.result.structuredContent.version, indexDefault.result.structuredContent.version);
    const indexRemote = await rpc(`http://127.0.0.1:${port}/mcp`, managedKey, "tools/call", { name: "index_status", arguments: { checkRemote: true } }, secondInit.session, 133);
    assert.equal(typeof indexRemote.result.structuredContent.remote, "object");
    const writtenNote = await rpc(`http://127.0.0.1:${port}/mcp`, managedKey, "tools/call", { name: "write_note", arguments: { path: "schema-contract.md", content: "first", overwrite: false } }, secondInit.session, 14);
    const appendedNote = await rpc(`http://127.0.0.1:${port}/mcp`, managedKey, "tools/call", { name: "append_to_note", arguments: { path: "schema-contract.md", content: "second", ifMatch: writtenNote.result.structuredContent.revision } }, secondInit.session, 15);
    assert.equal(appendedNote.result.structuredContent.created, false);
    assert.ok(appendedNote.result.structuredContent.currentSizeInBytes > appendedNote.result.structuredContent.previousSizeInBytes);
    const recovered = await rpc(`http://127.0.0.1:${port}/mcp`, managedKey, "tools/call", { name: "file_upload_status", arguments: { uploadId } }, secondInit.session, 16);
    assert.equal(recovered.result.structuredContent.nextOffset, 0);
    const encoded = Buffer.from("test").toString("base64");
    const completed = await rpc(`http://127.0.0.1:${port}/mcp`, managedKey, "tools/call", { name: "upload_file_chunk", arguments: { uploadId, offset: 0, base64: encoded, finalize: true } }, secondInit.session, 17);
    assert.equal(completed.result.structuredContent.complete, true);
    const replayed = await rpc(`http://127.0.0.1:${port}/mcp`, managedKey, "tools/call", { name: "upload_file_chunk", arguments: { uploadId, offset: 0, base64: encoded, finalize: true } }, secondInit.session, 18);
    assert.equal(replayed.result.structuredContent.idempotentReplay, true);
    assert.equal(await fs.readFile(path.join(root, "vault", "attachments", "reconnect.bin"), "utf8"), "test");
    const keysHtml = await (await fetch(`http://127.0.0.1:${port}/admin/auth?tab=keys`, { headers: { Cookie: cookie } })).text();
    // W3 Option B: the scopes editor is in the `?id=` drawer; rows expose their key id on that link.
    const keyIds = [...keysHtml.matchAll(/<td><a class="cell-link block" href="\/admin\/auth\?tab=keys&amp;id=([^"]+)"/g)].map((m) => m[1]);
    const managedKeyId = keyIds.find((id) => id !== "configured-env") || keyIds[0];
    assert.ok(managedKeyId);
    async function setManagedKeyAuthorization(scopes, vault) {
      const body = new URLSearchParams({ csrf, id: managedKeyId, allowedVault: vault });
      for (const scope of scopes) body.append("allowedScope", scope);
      const response = await fetch(`http://127.0.0.1:${port}/admin/auth/api-key/scopes`, {
        method: "POST",
        redirect: "manual",
        headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      assert.equal(response.status, 303);
    }

    await setManagedKeyAuthorization(["obsidian.write"], "vault");
    const deniedRead = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-API-Key": managedKey },
      body: JSON.stringify({ jsonrpc: "2.0", id: 19, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "managed-key-no-read", version: "1" } } }),
    });
    assert.equal(deniedRead.status, 403);
    assert.equal((await deniedRead.json()).error, "insufficient_scope");

    await setManagedKeyAuthorization(["obsidian.read"], "vault");
    const readOnlyKeyInit = await rpc(`http://127.0.0.1:${port}/mcp`, managedKey, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "managed-key-read-only", version: "1" } }, undefined, 20);
    const deniedWrite = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-API-Key": managedKey, "Mcp-Session-Id": readOnlyKeyInit.session },
      body: JSON.stringify({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "write_note", arguments: { path: "api-key-read-only-must-not-exist.md", content: "denied", overwrite: false } } }),
    });
    assert.equal(deniedWrite.status, 403);
    assert.equal((await deniedWrite.json()).error, "insufficient_scope");
    await assert.rejects(fs.access(path.join(root, "vault", "api-key-read-only-must-not-exist.md")));

    await setManagedKeyAuthorization(["obsidian.read", "obsidian.write"], "vault");
    const noFilesKeyInit = await rpc(`http://127.0.0.1:${port}/mcp`, managedKey, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "managed-key-no-files", version: "1" } }, undefined, 22);
    const deniedFiles = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-API-Key": managedKey, "Mcp-Session-Id": noFilesKeyInit.session },
      body: JSON.stringify({ jsonrpc: "2.0", id: 23, method: "tools/call", params: { name: "start_file_upload", arguments: { path: "attachments/no-files.bin", totalBytes: 1 } } }),
    });
    assert.equal(deniedFiles.status, 403);
    assert.equal((await deniedFiles.json()).error, "insufficient_scope");

    await setManagedKeyAuthorization(["obsidian.read"], "research");
    const scopedVaultInit = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-API-Key": managedKey },
      body: JSON.stringify({ jsonrpc: "2.0", id: 24, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "managed-key-test", version: "3" } } }),
    });
    assert.equal(scopedVaultInit.status, 200);
    const scopedSession = scopedVaultInit.headers.get("mcp-session-id");
    await scopedVaultInit.arrayBuffer();
    const scopedStatus = await rpc(`http://127.0.0.1:${port}/mcp`, managedKey, "tools/call", { name: "get_publish_status", arguments: { vaultId: "research", path: "Scoped.md" } }, scopedSession, 25);
    assert.equal(scopedStatus.result.structuredContent.vaultId, "research");
    const deniedVault = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-API-Key": managedKey, "Mcp-Session-Id": scopedSession },
      body: JSON.stringify({ jsonrpc: "2.0", id: 26, method: "tools/call", params: { name: "get_note", arguments: { path: "Published.md" } } }),
    });
    assert.equal(deniedVault.status, 403);
    assert.equal((await deniedVault.json()).error, "access_denied");

    // Revoking one local OAuth user's grants must not tear down another
    // principal's session merely because both authorized the same public client.
    const secondOwnInit = await rpc(
      `http://127.0.0.1:${port}/mcp`,
      null,
      "initialize",
      { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "oauth-second-owner", version: "1" } },
      undefined,
      63,
      { Authorization: `Bearer ${secondTokens.access_token}` },
    );

    // Revoking one access token is credential-specific. It must not tear down
    // another local user's session merely because both authorized the same
    // public OAuth client_id.
    assert.equal((await fetch(`http://127.0.0.1:${port}/`, {
      headers: { Authorization: `Bearer ${readTokens.access_token}` },
    })).status, 200);
    const revokeTokenHtml = await (await fetch(
      `http://127.0.0.1:${port}/admin/auth?tab=tokens&order=desc`,
      { headers: { Cookie: cookie } },
    )).text();
    // The grant row: the token cell names 访问/刷新 and the identity code holds the full id in `title`.
    const ownerReadAccessRow = (revokeTokenHtml.match(/<tr[\s\S]*?<\/tr>/g) || []).find((row) => row.includes(">访问 ") && row.includes("test-owner")
      && row.includes('title="obsidian.read"') && !row.includes('title="obsidian.write"') && !row.includes('title="obsidian.files"'));
    assert.ok(ownerReadAccessRow, "must find the active read-only access token for test-owner");
    const ownerReadAccessTokenId = ownerReadAccessRow.match(/<code class="idc" title="完整 ID：([^"]+)">/)?.[1];
    assert.ok(ownerReadAccessTokenId, "must resolve the read-only access token id");

    const revokeOneToken = await fetch(`http://127.0.0.1:${port}/admin/auth/oauth/token/revoke`, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, type: "access", id: ownerReadAccessTokenId }),
    });
    assert.equal(revokeOneToken.status, 303);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`, {
      headers: { Authorization: `Bearer ${readTokens.access_token}` },
    })).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`, {
      headers: { Authorization: `Bearer ${secondTokens.access_token}` },
    })).status, 200);

    const secondSessionAfterOtherTokenRevoke = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${secondTokens.access_token}`,
        "Mcp-Session-Id": secondOwnInit.session,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 65, method: "tools/list", params: {} }),
    });
    assert.equal(secondSessionAfterOtherTokenRevoke.status, 200,
      "revoking one user's token must not close another user's session sharing the same client_id");
    await secondSessionAfterOtherTokenRevoke.arrayBuffer();

    const freshWebLogin = await fetch(`http://127.0.0.1:${port}/auth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "test-owner", password: "test-oauth-password" }),
    });
    assert.equal(freshWebLogin.status, 303);
    const staleWebCookie = freshWebLogin.headers.get("set-cookie").split(";", 1)[0];

    const freshAccountsHtml = await (await fetch(
      `http://127.0.0.1:${port}/admin/auth?tab=accounts`,
      { headers: { Cookie: cookie } },
    )).text();
    // W3 Option B: the scopes form is in the `?id=` drawer; the row link exposes the account id.
    const firstUserId = freshAccountsHtml.match(/href="\/admin\/auth\?tab=accounts&amp;id=([^"]+)"[\s\S]{0,300}?test-owner/)?.[1];
    assert.ok(firstUserId, "must resolve the first OAuth user's admin id");

    const narrowFirstUser = await fetch(`http://127.0.0.1:${port}/admin/auth/oauth/user/scopes`, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrf,
        id: firstUserId,
        allowedScope: "obsidian.read",
        allowedVault: "vault",
      }),
    });
    assert.equal(narrowFirstUser.status, 303);

    // The changed user's Web session and OAuth grants must be invalid immediately.
    assert.equal((await fetch(
      `http://127.0.0.1:${port}/api/web/v1/session`,
      { headers: { Cookie: staleWebCookie } },
    )).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`, {
      headers: { Authorization: `Bearer ${refreshedTokens.access_token}` },
    })).status, 401);
    const revokedRefresh = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "198.51.100.8" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: registered.client_id,
        refresh_token: refreshedTokens.refresh_token,
        resource: `http://localhost:${port}/mcp`,
        scope: "obsidian.read",
      }),
    });
    assert.equal(revokedRefresh.status, 400);
    assert.equal((await revokedRefresh.json()).error, "invalid_grant");

    // The other local user still owns a valid token under the same client_id.
    assert.equal((await fetch(`http://127.0.0.1:${port}/`, {
      headers: { Authorization: `Bearer ${secondTokens.access_token}` },
    })).status, 200);

    const secondSessionAfterOtherUserUpdate = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${secondTokens.access_token}`,
        "Mcp-Session-Id": secondOwnInit.session,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 64, method: "tools/list", params: {} }),
    });
    assert.equal(secondSessionAfterOtherUserUpdate.status, 200,
      "updating one OAuth user must not close another user's session sharing the same client_id");
    await secondSessionAfterOtherUserUpdate.arrayBuffer();

    assert.doesNotMatch(output.join(""), /ERR_ERL_UNEXPECTED_X_FORWARDED_FOR/);
  } finally {
    await stopChild(child);
    await fs.rm(root, { recursive: true, force: true });
  }
});
