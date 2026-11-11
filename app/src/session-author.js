// Per MCP session + sticky auth-client author preference (e.g. from agent_bootstrap).
// Hosts that cannot send _meta[obsidian/author] on every mutation can declare
// identity once; subsequent writes reuse it.
//
// Some hosts (e.g. Grok/Cursor CallDynamicTool) open a fresh MCP session per tool
// call. Session-only storage then loses bootstrap model=... and falls back to
// unspecified. Sticky storage keyed by auth clientId survives session churn.
//
// One API key may be shared by several agents. The sticky key therefore also
// carries the caller's User-Agent: a Codex bootstrap on a shared key must not
// make a Pi Pocket (or any other) stateless request write as Codex. The UA is a
// display hint only; it never grants permission.

const bySession = new Map();
const byAuthClient = new Map();

/** Sticky entries kept at most; a caller cannot grow the map without limit. */
const MAX_AUTH_CLIENTS = 512;

/** `authClientId` + UA fingerprint, or null when the request has no auth client. */
function authClientKey(authClientId, clientFingerprint) {
  const client = String(authClientId ?? "").trim();
  if (!client) return null;
  const fingerprint = String(clientFingerprint ?? "").trim().slice(0, 240);
  return `${client}\u0000${fingerprint}`;
}

function normalizeAuthor(author) {
  if (!author) return undefined;
  return { agent: author.agent, model: author.model };
}

export function setSessionAuthor(sessionId, author, authClientId, clientFingerprint) {
  const value = normalizeAuthor(author);
  if (!value) return;
  if (sessionId) bySession.set(sessionId, value);
  const key = authClientKey(authClientId, clientFingerprint);
  if (key) {
    // Re-insert so insertion order keeps the newest entry last for eviction.
    byAuthClient.delete(key);
    byAuthClient.set(key, { ...value, updatedAt: Date.now() });
    while (byAuthClient.size > MAX_AUTH_CLIENTS) {
      byAuthClient.delete(byAuthClient.keys().next().value);
    }
  }
}

export function getSessionAuthor(sessionId, authClientId, clientFingerprint) {
  if (sessionId && bySession.has(sessionId)) return bySession.get(sessionId);
  const key = authClientKey(authClientId, clientFingerprint);
  if (key && byAuthClient.has(key)) {
    const hit = byAuthClient.get(key);
    return { agent: hit.agent, model: hit.model };
  }
  return undefined;
}

export function clearSessionAuthor(sessionId) {
  // Only drop the short-lived MCP session binding. Keep sticky auth-client
  // authors so reconnecting hosts still stamp the bootstrap model.
  if (!sessionId) return;
  bySession.delete(sessionId);
}

export function clearAuthClientAuthor(authClientId, clientFingerprint) {
  const client = String(authClientId ?? "").trim();
  if (!client) return;
  if (clientFingerprint === undefined) {
    const prefix = `${client}\u0000`;
    for (const key of [...byAuthClient.keys()]) {
      if (key.startsWith(prefix)) byAuthClient.delete(key);
    }
    return;
  }
  const key = authClientKey(client, clientFingerprint);
  if (key) byAuthClient.delete(key);
}

/** Test helper */
export function resetSessionAuthorsForTests() {
  bySession.clear();
  byAuthClient.clear();
}
