// OAuth endpoint hardening.
//
// Two upstream `@modelcontextprotocol/sdk` behaviours are tightened here, before
// the SDK auth router sees the request and before a response leaves the process:
//
// 1. `handlers/authorize.js` validates `code_challenge` as `z.string()` only, so a
//    one-character challenge is accepted. RFC 7636 requires 43-128 characters of
//    base64url, and a short challenge weakens the PKCE binding to the code.
// 2. `errors.js` serializes the raw Zod issue array into `error_description`, which
//    publishes the internal parameter schema to unauthenticated callers.
//
// The middleware is deliberately protocol-neutral: it never changes a successful
// response, never invents new OAuth error codes, and never rewrites an error that
// already carries a human-readable description.

const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const AUTHORIZE_PATHS = new Set(["/authorize", "/oauth/authorize"]);

// Generic replacements keyed by the OAuth error code the SDK already selected.
const GENERIC_ERROR_DESCRIPTIONS = {
  invalid_request: "The request is missing or has invalid parameters",
  invalid_client: "Client authentication failed",
  invalid_client_metadata: "The client metadata is invalid",
  invalid_grant: "The authorization grant is invalid or expired",
  invalid_scope: "The requested scope is invalid",
  invalid_token: "The access token is invalid or expired",
  unauthorized_client: "The client is not authorized to use this grant type",
  unsupported_response_type: "The response type is not supported",
  access_denied: "The resource owner denied the request",
  insufficient_scope: "The access token does not cover the required scope",
  server_error: "The authorization server encountered an error",
};

// A Zod issue dump is a JSON array whose entries carry `expected`/`invalid_type`.
export function isSerializedValidationError(description) {
  if (typeof description !== "string" || !description.trimStart().startsWith("[")) return false;
  try {
    const parsed = JSON.parse(description);
    return Array.isArray(parsed)
      && parsed.some((issue) => issue && typeof issue === "object" && "expected" in issue);
  } catch {
    return false;
  }
}

export function genericErrorDescription(error, description) {
  if (!isSerializedValidationError(description)) return description;
  return GENERIC_ERROR_DESCRIPTIONS[error] || "The request is invalid";
}

// Returns a problem string when the PKCE challenge is unusable, otherwise null.
export function validateAuthorizeChallenge(query) {
  const challenge = query?.code_challenge;
  if (typeof challenge !== "string" || !CODE_CHALLENGE_PATTERN.test(challenge)) {
    return "code_challenge must be 43-128 characters of base64url (RFC 7636)";
  }
  return null;
}

export function oauthEndpointHardening() {
  return function oauthEndpointHardeningMiddleware(req, res, next) {
    if (req.method === "GET" && AUTHORIZE_PATHS.has(req.path)) {
      const problem = validateAuthorizeChallenge(req.query);
      if (problem) {
        res.status(400).json({ error: "invalid_request", error_description: problem });
        return;
      }
    }
    const json = res.json.bind(res);
    res.json = (body) => {
      if (body && typeof body === "object" && !Array.isArray(body)
        && typeof body.error_description === "string") {
        const sanitized = genericErrorDescription(body.error, body.error_description);
        if (sanitized !== body.error_description) return json({ ...body, error_description: sanitized });
      }
      return json(body);
    };
    next();
  };
}
