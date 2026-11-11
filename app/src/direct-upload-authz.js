// Direct-upload authorization helpers, extracted from `direct-upload.js` to keep that file
// inside its line budget. Two jobs: resolve the Vault runtime for an id, and observe (never
// decide) the P2 continuation right.

import { MCP_LEGACY_VERDICTS, observeDirectUploadAuthorization } from "./authorization/adapters/mcp.js";

/**
 * The Vault runtime for an id: the injected resolver first, then the primary runtime. Any
 * other id resolves to null, so an unknown Vault is never probed.
 */
export function createUploadAuthz({ resolveVault = null, primaryRuntime, authorizationShadow = null } = {}) {
  function resolveRuntime(vaultId) {
    const resolved = typeof resolveVault === "function" ? resolveVault(vaultId) : null;
    if (resolved) return resolved;
    return vaultId === primaryRuntime.id ? primaryRuntime : null;
  }

  /**
   * P2 shadow of the continuation right: once the handle is located, the new model is asked
   * about the Vault the handle is BOUND to — the only target this request really touches.
   * Recorded before a body byte is read, and observation only: the old gates already decided.
   * A handle outside this caller's allowed Vaults is never found, so no unauthorized Vault is
   * ever probed for a row.
   */
  function observeUpload(req, vaultId) {
    if (authorizationShadow === null) return;
    observeDirectUploadAuthorization({
      shadow: authorizationShadow,
      authInfo: req.auth,
      vaultId,
      primaryVaultId: primaryRuntime.id,
      legacyDecision: MCP_LEGACY_VERDICTS.allowed,
    });
  }

  return { resolveRuntime, observeUpload };
}

/**
 * Find the owning Vault handle among the caller's allowed Vaults only. A handle that belongs to
 * another Vault is never probed, so a cross-Vault id cannot even be looked up.
 */
export function createUploadLocator({ resolveRuntime, runtimeFor, notFoundCode }) {
  return async function locate(uploadId, allowed) {
    for (const vaultId of allowed) {
      const vaultRuntime = resolveRuntime(vaultId);
      if (!vaultRuntime) continue;
      let metadata;
      try {
        metadata = await runtimeFor(vaultRuntime).peekDirectUpload(uploadId);
      } catch (error) {
        if (error?.code === notFoundCode || /Invalid uploadId/.test(error?.message || "")) continue;
        throw error;
      }
      const bound = metadata?.vaultId ?? (vaultRuntime.primary === true ? vaultId : null);
      if (bound !== vaultId) continue;
      return { vaultRuntime, vaultId, metadata };
    }
    return null;
  };
}
