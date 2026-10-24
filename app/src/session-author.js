// Per MCP session + sticky auth-client author preference (e.g. from agent_bootstrap).
// Hosts that cannot send _meta[obsidian/author] on every mutation can declare
// identity once; subsequent writes reuse it.
//
// Some hosts (e.g. Grok/Cursor CallDynamicTool) open a fresh MCP session per tool
// call. Session-only storage then loses bootstrap model=... and falls back to
// unspecified. Sticky storage keyed by auth clientId survives session churn.

const bySession = new Map();
const byAuthClient = new Map();

function normalizeAuthor(author) {
  if (!author) return undefined;
  return { agent: author.agent, model: author.model };
}

export function setSessionAuthor(sessionId, author, authClientId) {
  const value = normalizeAuthor(author);
  if (!value) return;
  if (sessionId) bySession.set(sessionId, value);
  if (authClientId) {
    byAuthClient.set(String(authClientId), { ...value, updatedAt: Date.now() });
  }
}

export function getSessionAuthor(sessionId, authClientId) {
  if (sessionId && bySession.has(sessionId)) return bySession.get(sessionId);
  if (authClientId && byAuthClient.has(String(authClientId))) {
    const hit = byAuthClient.get(String(authClientId));
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

export function clearAuthClientAuthor(authClientId) {
  if (!authClientId) return;
  byAuthClient.delete(String(authClientId));
}

/** Test helper */
export function resetSessionAuthorsForTests() {
  bySession.clear();
  byAuthClient.clear();
}
