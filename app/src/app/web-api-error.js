// Publish surface error mapping (#277/#278, Wave C / C1).
// The domain codes come from A1's authoritative gate so there is a single definition (§16).
import {
  INVALID_PUBLISH_TARGET_PATH,
  PUBLISH_TARGET_MISSING,
  PUBLISH_TARGET_NOT_A_FILE,
  PUBLISH_TARGET_TOO_LARGE,
  UNSUPPORTED_PUBLISH_TARGET,
} from "../publish/target.js";

const PATH_ERROR_PATTERNS = [
  /Invalid document route/i,
  /Invalid Vault path/i,
  /Path traversal denied/i,
  /Symbolic link escapes/i,
  /Protected attachment path/i,
  /Invalid local attachment target/i,
  /Unsupported attachment type/i,
];

// Contract §7: the machine-readable `code` — not the prose — is the cross-surface contract,
// so a publish rejection answers the frozen domain code plus a generic message that never
// carries a server path (§15 S03). §7 fixes `unsupported → 400` and `missing → 404`; the
// C1 brief fixes the §12.2 directory/oversize reject rows to 400 as well.
const PUBLISH_TARGET_RESPONSES = new Map([
  [UNSUPPORTED_PUBLISH_TARGET, { status: 400, error: "Unsupported publish target" }],
  [PUBLISH_TARGET_NOT_A_FILE, { status: 400, error: "Publish target is not a file" }],
  [PUBLISH_TARGET_TOO_LARGE, { status: 400, error: "Publish target exceeds the size limit" }],
  [PUBLISH_TARGET_MISSING, { status: 404, error: "Publish target not found" }],
  [INVALID_PUBLISH_TARGET_PATH, { status: 400, error: "Invalid path" }],
]);

export function classifyWebApiError(error) {
  const code = String(error?.code || "");
  const type = String(error?.type || "");
  const message = error instanceof Error ? error.message : String(error || "");

  const publishTarget = PUBLISH_TARGET_RESPONSES.get(code);
  if (publishTarget) return { ...publishTarget, code };

  if (code === "ENOENT") return { status: 404, error: "Not found" };
  if (code === "INVALID_SEARCH_QUERY") return { status: 400, error: "Invalid search query" };
  if (type === "entity.parse.failed") return { status: 400, error: "Invalid JSON request body" };
  if (type === "entity.too.large" || error?.status === 413 || error?.statusCode === 413) {
    return { status: 413, error: "Request body too large" };
  }

  if (message === "Vault access denied") return { status: 403, error: "Vault access denied" };
  if (message === "Invalid Vault name" || PATH_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
    return { status: 400, error: "Invalid path" };
  }
  if (message === "Vault already exists") return { status: 409, error: "Vault already exists" };
  if (message === "Multi-Vault management is not configured") {
    return { status: 409, error: "Vault creation is not available" };
  }
  if (message === "Existing notes require a revision" || /^Revision conflict:/i.test(message)) {
    return { status: 409, error: "Revision conflict" };
  }
  if (message === "Note exceeds the Web editor limit") {
    return { status: 413, error: "Note exceeds the Web editor limit" };
  }

  return { status: 500, error: "Request failed" };
}
