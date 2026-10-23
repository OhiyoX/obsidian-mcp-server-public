const RULES = [
  ["chatgpt", /(?:chatgpt|openai[-/ ](?:connector|mcp|agent))/i],
  ["codex", /(?:\bcodex\b|codex_cli_rs)/i],
  ["cursor", /\bcursor\b/i],
  ["workbuddy", /\bworkbuddy\b/i],
  ["openclaw", /\bopenclaw\b/i],
  ["hermes", /\bhermes(?:[-/ ]agent)?\b/i],
  ["claude", /(?:\bclaude\b|anthropic)/i],
  ["vscode", /(?:visual studio code|\bvscode\b)/i],
  ["mcp-inspector", /mcp[-/ ]inspector/i],
];

function header(headers, name) {
  if (!headers) return "";
  const wanted = name.toLowerCase();
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted)?.[1];
  return Array.isArray(value) ? value.join(" ") : String(value || "");
}

/**
 * User-Agent is untrusted and spoofable. This helper only supplies a display and
 * attribution hint when MCP clientInfo is generic; it never grants permission.
 */
export function identifyAgentFromUserAgent(value) {
  const userAgent = typeof value === "string" ? value : header(value, "user-agent");
  for (const [agent, pattern] of RULES) {
    if (pattern.test(userAgent)) return agent;
  }
  return null;
}

// Display-only classification for the Admin audit table (issue #285). A programmatic
// client (undici/node/httpx/...) declares no identity, so the Agent column would be
// blank; the audit shows "通用客户端（无 UA 身份）" instead of pretending it is one of
// the hosts above. Never used for authentication, Scope, Vault, AuthZ or allow/deny.
const GENERIC_UA_RULES = [
  ["undici", /\bundici\b/i],
  ["node", /node-fetch|\bnode(?:\.js)?\b/i],
  ["requests", /python-requests|python-urllib|\brequests\b/i],
  ["httpx", /\bhttpx\b/i],
  ["axios", /\baxios\b/i],
  ["okhttp", /\bokhttp\b/i],
  ["go-http-client", /go-http-client/i],
];

export function classifyGenericUserAgent(value) {
  const userAgent = (typeof value === "string" ? value : header(value, "user-agent")).trim();
  if (!userAgent) return "generic";
  if (identifyAgentFromUserAgent(userAgent)) return null;
  for (const [kind, pattern] of GENERIC_UA_RULES) {
    if (pattern.test(userAgent)) return kind;
  }
  return null;
}

export function requestUserAgent(extra) {
  return header(extra?.requestInfo?.headers, "user-agent").replace(/[\r\n\0]/g, " ").slice(0, 240);
}
