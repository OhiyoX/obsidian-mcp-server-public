// Prototype-parity gate — fixture seeding.
//
// The gate compares *rendered* pages, so every list page must have at least one real row: the
// prototype's `table()` renders nothing at all for an empty list (it swaps in `.empty`), and the
// Admin plane is expected to do the same, so with an empty fixture the column comparison would
// have nothing to compare. Everything here goes through the real routes — the Admin form posts,
// dynamic client registration, a real authorization-code + PKCE exchange and real MCP calls — so
// the pages are driven by the same data a deployment produces, and a seeding failure is reported
// instead of being papered over.
//
// Order is load-bearing: the access policy would suspend the fixture's configured-env API key
// outside its weekly window, so every MCP call happens *before* the policy is created.

const JSON_HEADERS = { "content-type": "application/json" };
const FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded" };

/**
 * The prototype's own fixture carries rows whose *state* is part of the required elements: a client
 * with a pending authorization transfer (`.tag.amber` 转移中), a retired publication
 * (`.banner.amber` 已失效) and a policy with an orphaned subject plus an `all` capability chip
 * (`.banner.amber` + `.tag.amber`). Those states are seeded through the real routes below instead
 * of being excluded from the gate — a criterion that silently disappears with the fixture is not a
 * criterion (lane w5-gates-fix).
 */
const RETIRED_PUBLISH_PATH = "notes/gate-published.md";
/** An `api-key:<uuid>` that no credential will ever have: the policy subject stays orphaned. */
const ORPHAN_SUBJECT = "api-key:9f1c0b6e-3a44-4c1f-9a2d-7e5b8c0d1f22";
/** The seeded OAuth account's display name — the transfer target, so the pick is not order-dependent. */
const GATE_ACCOUNT_DISPLAY_NAME = "Gate 账户";

function decodeForm(html, name) {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  return match ? match[1] : null;
}

/**
 * `<a …href="…tab=accounts&id=<id>…">NAME</a>` pairs, in document order. `esc()` writes the query
 * separator into the attribute as `&amp;`, so both spellings are accepted.
 */
function linkedAccountIds(html) {
  return [...String(html).matchAll(/tab=accounts&(?:amp;)?id=([^"&]+)"[^>]*>([^<]*)</g)]
    .map((match) => ({ id: match[1], name: match[2] }));
}

/** The account ids of the accounts list page, taken from each row's own detail link. */
function accountRowIds(html) {
  return [...String(html).matchAll(/tab=accounts&(?:amp;)?id=([^"&]+)"[^>]*>\s*<div class="nm"><b>([^<]*)</g)]
    .map((match) => ({ id: match[1], name: match[2] }));
}

async function adminLogin(base, password) {
  const login = await fetch(`${base}/admin/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: FORM_HEADERS,
    body: new URLSearchParams({ password }),
  });
  if (login.status !== 303) throw new Error(`admin login failed: ${login.status}`);
  const cookie = String(login.headers.get("set-cookie") || "").split(";", 1)[0];
  const page = await fetch(`${base}/admin/auth`, { headers: { cookie } });
  const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)?.[1] ?? null;
  if (!csrf) throw new Error("admin page exposes no CSRF token");
  return { cookie, csrf };
}

async function postForm(base, url, fields, cookie) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) body.append(key, String(item ?? ""));
  }
  return fetch(`${base}${url}`, { method: "POST", redirect: "manual", headers: { ...FORM_HEADERS, cookie }, body });
}

/** One real MCP tool call over `x-api-key` (its own session, like `admin-layout-fixture.mjs`). */
async function mcpCall(base, apiKey, name, args) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "x-api-key": apiKey };
  const post = async (body, sessionId) => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: sessionId ? { ...headers, "mcp-session-id": sessionId } : headers,
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { const line = text.split("\n").find((item) => item.startsWith("data: ")); if (line) json = JSON.parse(line.slice(6)); }
    return { sessionId: response.headers.get("mcp-session-id"), json, text, status: response.status };
  };
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "admin-parity-gate", version: "1.0" } } });
  if (!init.sessionId) throw new Error(`MCP initialize failed: ${init.status} ${init.text.slice(0, 200)}`);
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, init.sessionId);
  const call = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, init.sessionId);
  if (call.json?.result?.isError) throw new Error(`MCP ${name} failed: ${call.text.slice(0, 200)}`);
  return call.json?.result;
}

/**
 * Seed one row for every list page. Returns `{ steps, errors, client, account }`; `errors` is a
 * list of `"<step>: <message>"` lines the gate turns into failures (a page with no row cannot be
 * compared, so a seeding failure must never be swallowed).
 */
export async function seedParityFixture({ base, password, apiKey, vaultId = "default", username = "gate-account", webUser, webPassword }) {
  const steps = [];
  const errors = [];
  const step = async (name, run) => {
    try {
      const value = await run();
      steps.push({ name, ok: true, detail: typeof value === "string" ? value : undefined });
      return value;
    } catch (error) {
      steps.push({ name, ok: false, detail: String(error?.message || error) });
      errors.push(`${name}: ${error?.message || error}`);
      return null;
    }
  };

  const session = await step("admin login", () => adminLogin(base, password));
  const scopes = ["obsidian.read", "obsidian.write", "obsidian.files"];

  // R2 (Wave R): the seed is IDEMPOTENT BY CONDITION, not by convention. This gate used to depend on
  // another scene having seeded the fixture first: run it alone on a clean fixture and it compared
  // empty pages against the prototype's populated mock (3/7 checks green, ~150 "differences" that were
  // really "there are no rows"). Every caller may now call it; if the fixture already has the rows,
  // the seed says so and does nothing (creating a second account/policy would change what the other
  // scenes measure).
  if (session?.cookie) {
    const hasRows = async (url, pattern) => {
      const response = await fetch(`${base}${url}`, { headers: { cookie: session.cookie } });
      return pattern.test(await response.text());
    };
    const [accounts, policies] = await Promise.all([
      hasRows("/admin/auth?tab=accounts", /tab=accounts&(?:amp;)?id=[^"]+/),
      hasRows("/admin/auth/access-policy", /access-policy\/(?:toggle|delete)/),
    ]);
    if (accounts && policies) {
      steps.push({ name: "fixture already seeded (skipped)", ok: true, detail: "accounts + access policies present" });
      return { steps, errors, client: null, account: null, seeded: false };
    }
  }

  await step("create OAuth account", async () => {
    const created = await postForm(base, "/admin/auth/oauth/user/create", {
      csrf: session.csrf, username, displayName: GATE_ACCOUNT_DISPLAY_NAME, password: `${username}-password-0123456789`,
      allowedScope: scopes, allowedVault: [vaultId],
    }, session.cookie);
    if (created.status !== 303) throw new Error(`status ${created.status}`);
    return `303 → ${created.headers.get("location")}`;
  });

  await step("create API Key", async () => {
    const created = await postForm(base, "/admin/auth/api-key/create", {
      csrf: session.csrf, label: "gate key（未命名占位）", allowedScope: scopes, allowedVault: [vaultId],
    }, session.cookie);
    if (created.status !== 303) throw new Error(`status ${created.status}`);
    return "303";
  });

  // MCP calls first: the access policy created below suspends this key outside its window.
  await step("MCP write_note (audit row + pending batch)", () => mcpCall(base, apiKey, "write_note", { path: "notes/gate-write.md", overwrite: true, content: "# parity gate\n" }));
  await step("MCP manage_publish (publish row)", () => mcpCall(base, apiKey, "manage_publish", { action: "publish", path: "notes/seed.md" }));
  // The prototype renders one retired publication and its amber banner is a required element, so the
  // fixture really publishes and then removes the source note: `list({includeInactive:true})`
  // re-observes every record on each Admin page load, which retires the row (lifecycle `orphaned`).
  await step("MCP publish + delete source note (retired publish row)", async () => {
    await mcpCall(base, apiKey, "write_note", { path: RETIRED_PUBLISH_PATH, overwrite: true, content: "# publish gate\n" });
    await mcpCall(base, apiKey, "manage_publish", { action: "publish", path: RETIRED_PUBLISH_PATH });
    await mcpCall(base, apiKey, "delete_note", { path: RETIRED_PUBLISH_PATH });
    return `${RETIRED_PUBLISH_PATH} published then deleted`;
  });

  const client = await step("OAuth client registration + token exchange", async () => {
    const callback = `${base}/callback`;
    const registered = await (await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        client_name: "parity gate client",
        redirect_uris: [callback],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    })).json();
    if (!registered.client_id) throw new Error(`registration returned ${JSON.stringify(registered).slice(0, 200)}`);
    const verifier = "parity-gate-verifier-0123456789-abcdefghijklmnop";
    const challenge = (await import("node:crypto")).createHash("sha256").update(verifier).digest("base64url");
    const authorize = new URL(`${base}/oauth/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code", client_id: registered.client_id, redirect_uri: callback,
      code_challenge: challenge, code_challenge_method: "S256", state: "parity", resource: `${base}/mcp`, scope: "obsidian.read",
    }).toString();
    const consent = await (await fetch(authorize)).text();
    const transaction = decodeForm(consent, "transaction");
    if (!transaction) throw new Error("consent page exposes no transaction");
    const approved = await fetch(`${base}/oauth/decision`, {
      method: "POST",
      redirect: "manual",
      headers: FORM_HEADERS,
      body: new URLSearchParams({ transaction, username: webUser, password: webPassword, scope: "obsidian.read", decision: "allow" }),
    });
    if (approved.status !== 302) throw new Error(`decision status ${approved.status}`);
    const code = new URL(approved.headers.get("location")).searchParams.get("code");
    const tokens = await (await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: FORM_HEADERS,
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: registered.client_id, code, code_verifier: verifier, redirect_uri: callback, resource: `${base}/mcp` }),
    })).json();
    if (!tokens.access_token || !tokens.refresh_token) throw new Error(`token exchange returned ${JSON.stringify(tokens).slice(0, 200)}`);
    return { clientId: registered.client_id, callback };
  });

  await step("create access policy", async () => {
    // All seven days 00:00-24:00 with a single capability: the gate's own MCP calls (which need
    // `obsidian.write`) must stay inside the window and outside the capability set, so the seeded
    // policy exercises a real row without making every later MCP call a policy decision.
    const weekly = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => `${day} 00:00-24:00`).join("\n");
    const created = await postForm(base, "/admin/auth/access-policy/create", {
      csrf: session.csrf, label: "parity-gate-policy", mode: "suspend", enabled: "true", timezone: "Asia/Shanghai",
      startsAt: "", expiresAt: "", subjects: ["api-key:configured-env"], capabilities: "scope:obsidian.read",
      weekly, dateRanges: "",
    }, session.cookie);
    if (created.status !== 303) throw new Error(`status ${created.status}`);
    return "303";
  });

  // The prototype's authz page renders both amber marks for a data state that is not an error: a
  // policy whose subject no longer resolves (孤立主体 banner) and an `all` capability chip. A
  // `revoke`-mode policy is the real route to `capabilities: ["all"]` (the server forces it), and
  // its subject is a credential that will never exist, so it can never match the fixture's calls.
  await step("create orphan-subject policy (孤立主体 + all capability chip)", async () => {
    const weekly = ["mon 00:00-24:00"].join("\n");
    const created = await postForm(base, "/admin/auth/access-policy/create", {
      csrf: session.csrf, label: "parity-gate-orphan", mode: "revoke", enabled: "true", timezone: "Asia/Shanghai",
      startsAt: "", expiresAt: "", subjects: [ORPHAN_SUBJECT], capabilities: ["all"],
      weekly, dateRanges: "",
    }, session.cookie);
    if (created.status !== 303) throw new Error(`status ${created.status}`);
    return `303 · subject ${ORPHAN_SUBJECT}`;
  });

  // A pending authorization transfer is the clients page's other data state (`.tag.amber` 转移中):
  // the real route revokes the source account's grant and leaves a durable pending record, exactly
  // like the prototype's own `CLIENTS[0].transfer`.
  await step("begin authorization transfer (clients 转移中)", async () => {
    if (!client?.clientId) throw new Error("OAuth client registration did not provide a client id");
    const clientsHtml = await (await fetch(`${base}/admin/auth?tab=clients`, { headers: { cookie: session.cookie } })).text();
    const row = clientsHtml.split("<tr").find((chunk) => chunk.includes(client.clientId));
    const source = row ? linkedAccountIds(row)[0] : null;
    if (!source) throw new Error(`client ${client.clientId} renders no linked account to transfer from`);
    const accountsHtml = await (await fetch(`${base}/admin/auth?tab=accounts`, { headers: { cookie: session.cookie } })).text();
    const accounts = accountRowIds(accountsHtml);
    // Named, not positional: the target must be the account this seed created, and an enabled one.
    const target = accounts.find((item) => item.name === GATE_ACCOUNT_DISPLAY_NAME && item.id !== source.id)
      ?? accounts.find((item) => item.id !== source.id);
    if (!target) throw new Error(`no second account to transfer to（源 ${source.name}）`);
    const begun = await postForm(base, "/admin/auth/oauth/client/transfer", {
      csrf: session.csrf, clientId: client.clientId, sourceUserId: source.id, targetUserId: target.id,
    }, session.cookie);
    if (begun.status !== 303) throw new Error(`status ${begun.status}（${source.name} → ${target.name}）`);
    return `303 · ${source.name} → ${target.name}`;
  });

  // The prototype's fixture carries two more states the plane renders from real data, so the gate
  // can require them instead of waiving them away:
  //   * a failed admin login — the overview's 需要关注 行「管理登录失败 N 次」, its 最近失败 list and
  //     the sidebar's red `.dot.danger` on 审计 all come from one `admin.login` failure row;
  //   * one disabled account — the accounts page's `.dim` · `.st.off 已停用` row and the overview's
  //     `1 个已停用` warning.
  // Both happen LAST: the login failure would count toward the 8/15min lockout, and disabling the
  // seed's own account (which holds no grant) must not break the transfer above.
  await step("failed admin login (审计失败行 + 侧栏红点)", async () => {
    const wrong = `wrong-${(await import("node:crypto")).randomBytes(8).toString("hex")}`;
    const response = await fetch(`${base}/admin/auth/login`, {
      method: "POST", redirect: "manual", headers: FORM_HEADERS, body: new URLSearchParams({ password: wrong }),
    });
    if (response.status !== 403) throw new Error(`status ${response.status}（期望 403，锁定阈值是 8 次/15 分钟）`);
    return "403 · 1 次（阈值 8）";
  });

  // The prototype's client rows show a linked account AND a pending transfer (its fixture spreads
  // those over several clients). With a single granted client the transfer consumes the only link,
  // so the fixture grants a SECOND client to the seed's own account — one real code exchange through
  // the real routes — and both row shapes exist afterwards.
  await step("second OAuth client granted to the seeded account (客户端行态：已授权账户)", async () => {
    const registered = await (await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        client_name: "parity gate client 2",
        redirect_uris: [`${base}/callback-2`],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    })).json();
    if (!registered.client_id) throw new Error(`registration returned ${JSON.stringify(registered).slice(0, 200)}`);
    const verifier = "parity-gate-verifier-2-0123456789-abcdefghijkl";
    const challenge = (await import("node:crypto")).createHash("sha256").update(verifier).digest("base64url");
    const authorize = new URL(`${base}/oauth/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code", client_id: registered.client_id, redirect_uri: `${base}/callback-2`,
      code_challenge: challenge, code_challenge_method: "S256", state: "parity2", resource: `${base}/mcp`, scope: "obsidian.read",
    }).toString();
    const transaction = decodeForm(await (await fetch(authorize)).text(), "transaction");
    if (!transaction) throw new Error("consent page exposes no transaction");
    const approved = await fetch(`${base}/oauth/decision`, {
      method: "POST", redirect: "manual", headers: FORM_HEADERS,
      body: new URLSearchParams({ transaction, username, password: `${username}-password-0123456789`, scope: "obsidian.read", decision: "allow" }),
    });
    if (approved.status !== 302) throw new Error(`decision status ${approved.status}`);
    const code = new URL(approved.headers.get("location")).searchParams.get("code");
    const tokens = await (await fetch(`${base}/oauth/token`, {
      method: "POST", headers: FORM_HEADERS,
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: registered.client_id, code, code_verifier: verifier, redirect_uri: `${base}/callback-2`, resource: `${base}/mcp` }),
    })).json();
    if (!tokens.access_token) throw new Error(`token exchange returned ${JSON.stringify(tokens).slice(0, 200)}`);
    return `granted · ${registered.client_id}`;
  });

  await step("create a third account and disable it (已停用行态)", async () => {
    // The prototype's fixture has ONE disabled account (a `.dim` row) beside enabled ones. It must be
    // neither of the two accounts the other gates use:
    //   * `layout-gate` (the seed's OAuth web user) logs in on the consent page in the no-JS gate;
    //   * `gate-account` carries the linked client created above.
    // So the fixture adds its own account and disables that.
    const made = await postForm(base, "/admin/auth/oauth/user/create", {
      csrf: session.csrf, username: "gate-disabled", displayName: "Gate 停用账户",
      password: "gate-disabled-password-0123456789", allowedScope: scopes, allowedVault: [vaultId],
    }, session.cookie);
    if (made.status !== 303) throw new Error(`create status ${made.status}`);
    const accountsHtml = await (await fetch(`${base}/admin/auth?tab=accounts`, { headers: { cookie: session.cookie } })).text();
    const target = accountRowIds(accountsHtml).find((item) => item.name === "Gate 停用账户") ?? null;
    if (!target) throw new Error("the fixture's own disabled account is not on the accounts page");
    const done = await postForm(base, "/admin/auth/oauth/user/toggle", { csrf: session.csrf, id: target.id, disabled: "true", confirmed: "1" }, session.cookie);
    if (done.status !== 303) throw new Error(`toggle status ${done.status}`);
    return `303 · ${target.name} 已停用`;
  });

  await step("disable the orphan-subject policy (策略 dim 行态)", async () => {
    // The prototype's fixture has one disabled policy (`.dim` row, `.st.off 停用`). Disabling the
    // orphan-subject policy keeps every other state intact (it never matched anything anyway).
    const list = await (await fetch(`${base}/admin/auth/access-policy`, { headers: { cookie: session.cookie } })).text();
    const row = String(list).split("<tr").find((chunk) => chunk.includes("parity-gate-orphan"));
    const policyId = row ? (row.match(/edit=([0-9a-fA-F-]{8,})/) || [])[1] : null;
    if (!policyId) throw new Error("the orphan policy id is not on the list page");
    const done = await postForm(base, "/admin/auth/access-policy/toggle", { csrf: session.csrf, id: policyId, enabled: "false", confirmed: "1" }, session.cookie);
    if (done.status !== 303) throw new Error(`status ${done.status}`);
    return `303 · ${policyId} 停用`;
  });

  return { steps, errors, client, account: { username }, seeded: true };
}
