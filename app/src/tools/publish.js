import { z } from "zod/v4";
import { PUBLIC_BASE_URL } from "../server-config.js";
import { defaultWebVaultId } from "../app/vault-registry.js";
import { encodeDocumentRoute, publishService } from "../publish/service.js";
import {
  INVALID_PUBLISH_TARGET_PATH,
  PUBLISH_TARGET_ERROR_CODES,
  PUBLISH_TARGET_MISSING,
  PUBLISH_TARGET_NOT_A_FILE,
  PUBLISH_TARGET_TOO_LARGE,
  UNSUPPORTED_PUBLISH_TARGET,
  isPublishTargetError,
} from "../publish/target.js";
import { requestContext } from "../request-context.js";
import { err, ok } from "../result.js";

// Contract §7: the machine-readable *code* is the cross-surface contract, the prose is
// not. Contract §15 S03: a Publish-tool payload must never expose a server absolute
// path — and a raw IO error (`ENOENT … realpath '<server path>'`) is exactly where one
// leaks. So the adapter below builds its text from the frozen code plus the
// Vault-relative target only; a service/fs message is never relayed verbatim.
const TARGET_MESSAGES = Object.freeze({
  [UNSUPPORTED_PUBLISH_TARGET]: "Publish target must be a Markdown (.md) file",
  [INVALID_PUBLISH_TARGET_PATH]: "Invalid Vault path",
  [PUBLISH_TARGET_MISSING]: "Publish target not found",
  [PUBLISH_TARGET_NOT_A_FILE]: "Publish target is not a regular file",
  [PUBLISH_TARGET_TOO_LARGE]: "Publish target exceeds the Publish size limit",
});

// Absolute / UNC / drive-qualified / backslash spellings are dropped instead of echoed,
// even when the caller supplied them (§15 S02/S03).
function relativeTargetPath(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.includes("\0") || text.includes("\\") || text.startsWith("/") || /^[A-Za-z]:/.test(text)) return null;
  return text;
}

function targetFailure(code, path) {
  const base = TARGET_MESSAGES[code] || "Publish request rejected";
  const message = path ? `${base}: ${path}` : base;
  const structuredContent = { code, message, ...(path ? { path } : {}) };
  return { content: [{ type: "text", text: `Error: ${message}` }], structuredContent, isError: true };
}

// A domain refusal keeps its frozen code; a missing `get_publish_status` target arrives
// as a raw fs ENOENT from `statWebNote` and is classified too. Vault resolution reuses
// the ENOENT code for an unknown Vault id, so that one stays plain prose.
function publishFailure(error, userPath) {
  if (isPublishTargetError(error)) {
    const code = PUBLISH_TARGET_ERROR_CODES.includes(error?.code) ? error.code : UNSUPPORTED_PUBLISH_TARGET;
    return targetFailure(code, relativeTargetPath(error?.path) ?? relativeTargetPath(userPath));
  }
  if (error?.code === "ENOENT" && !/Vault not found/i.test(String(error?.message || ""))) {
    return targetFailure(PUBLISH_TARGET_MISSING, relativeTargetPath(userPath));
  }
  return err(new Error(pathFreeProse(error)));
}

function pathFreeProse(error) {
  const message = error instanceof Error ? error.message : String(error);
  const pathLike = /(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|\/(?:[^/\s]+\/)+)/;
  return pathLike.test(message) ? "Publish request failed" : message;
}

// Contract §7.3 / §43-4: the canonical optional `vaultId` input is injected by the vault-scope
// registrar (`vault-scope-registrar.js`) and the credential allowlist is enforced there (HTTP gate
// + request-level defense-in-depth). This module keeps no second allowlist and no local vaultId
// field — it only reads the Vault the registrar selected for this request.
function targetVault() {
  const selected = requestContext()?.vaultId;
  return typeof selected === "string" && selected !== "" ? selected : defaultWebVaultId();
}

function payload(vaultId, notePath, record) {
  const origin = String(PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  const privatePath = `/app/note/${encodeDocumentRoute(vaultId, notePath)}`;
  const publicPath = record ? `/publish/${record.id}` : null;
  return {
    vaultId,
    path: notePath,
    privatePath,
    privateUrl: origin ? `${origin}${privatePath}` : privatePath,
    published: Boolean(record),
    publicPath,
    publicUrl: publicPath ? (origin ? `${origin}${publicPath}` : publicPath) : null,
    publishedAt: record?.createdAt || null,
  };
}

export function registerPublishTools(server) {
  server.registerTool("get_publish_status", {
    title: "Get note publish status",
    description: "Return the authenticated document route and current anonymous Publish status for one Markdown note. Vault access is limited by the credential allowlist.",
    inputSchema: {
      path: z.string().min(1),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ path }) => {
    try {
      const status = await publishService.status(targetVault(), path);
      return ok(payload(status.vault.id, status.note.path, status.record));
    } catch (error) {
      return publishFailure(error, path);
    }
  });

  server.registerTool("manage_publish", {
    title: "Manage note Publish",
    description: "Publish or revoke the anonymous read-only link for one Markdown note. Publishing never exposes Vault browsing, search, backlinks, or attachments.",
    inputSchema: {
      action: z.enum(["publish", "revoke"]),
      path: z.string().min(1),
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ action, path }, extra) => {
    try {
      const id = targetVault();
      if (action === "revoke") {
        // §7/#277: revoke is a cleanup path, so a missing or orphaned target is a
        // *successful* structured result (`revoked: false` / `revoked: true`). It must
        // never re-stat the path afterwards, which is what surfaced ENOENT before.
        //
        // NOTE: `revoked` is deliberately left out of the declared `manage_publish`
        // output contract in `src/tool-contracts.js`: the Wave-1 baseline
        // (`docs/review/tool-discovery/inventory.json`) freezes every historical
        // `outputContract` digest and has no audited *output*-widening allowance, so
        // declaring the field would break the root-tool-inventory and
        // capability-catalog drift gates. `outputSchemaForTool()` emits a passthrough
        // object, so the field is still wire-valid (asserted by the MCP tests).
        const revoked = await publishService.revoke(id, path);
        return ok({
          ...payload(revoked.vaultId, revoked.path, null),
          changed: revoked.revoked === true,
          revoked: revoked.revoked === true,
        });
      }
      const author = requestContext()?.author;
      const actor = author ? `mcp:${author.agent}/${author.model}` : `mcp:${extra?.authInfo?.clientId || "client"}`;
      const published = await publishService.publish(id, path, { actor });
      return ok({ ...payload(published.vaultId, published.path, published), changed: published.created === true });
    } catch (error) {
      return publishFailure(error, path);
    }
  });
}
