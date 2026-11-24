// Prompt Registry Admin API (issue #825).
//
// The console session and its CSRF token are the only way to publish prompt copy:
// no MCP tool, API key or OAuth scope reaches these routes. The JSON body limit is
// applied per route, so the Admin plane's existing 32 KB form budget stays as it is.

import express from "express";
import { COMPACT_GROUPS } from "../../compact-tools.js";
import { TOOL_NAMES } from "../../config.js";
import { MCP_PROMPT_NAMES } from "../../prompts.js";
import { bundledBasePack } from "../../prompt-registry/bundled.js";
import { PROMPT_BASE_LIMITS, validateBasePack, validateBaseValues } from "../../prompt-registry/schema.js";

const BASE = "/prompt-registry";
// The pack's own ceiling is 1 MiB of text; the body adds JSON keys and escaping, so
// the transport budget is 2x, not a free 3x. The schema is the authority on size.
const BODY_LIMIT = `${Math.ceil((PROMPT_BASE_LIMITS.pack * 2) / (1024 * 1024))}mb`;

function noStore(_req, res, next) {
  res.set("Cache-Control", "no-store");
  next();
}

/** Build a Base pack from either a raw value map or a manifest + file map. */
function packFromBody(body) {
  const pack = body?.pack;
  if (pack === null || typeof pack !== "object") throw Object.assign(new Error("pack is required"), { status: 422 });
  if (pack.values !== undefined) {
    // Same rules as the manifest + files shape: a value map must not be a way
    // around the schema (undeclared key or placeholder, oversize, control chars).
    const validated = validateBaseValues({ manifest: bundledBasePack().manifest, values: pack.values, ...catalog() });
    if (pack.digest !== undefined && pack.digest !== validated.digest) {
      throw Object.assign(new Error("pack digest does not match its values"), { status: 422, reason: "digest-mismatch" });
    }
    return { values: validated.values, digest: validated.digest };
  }
  if (pack.manifest === undefined || pack.files === undefined) {
    throw Object.assign(new Error("pack needs manifest + files, or values"), { status: 422 });
  }
  if (pack.files === null || typeof pack.files !== "object" || Array.isArray(pack.files)) {
    throw Object.assign(new Error("pack.files must map file path to text"), { status: 422 });
  }
  const files = new Map();
  for (const [file, text] of Object.entries(pack.files)) {
    if (typeof text !== "string") throw Object.assign(new Error(`file ${file} is not text`), { status: 422 });
    files.set(file, Buffer.from(text, "utf8"));
  }
  const validated = validateBasePack({ manifest: pack.manifest, files, ...catalog() });
  return { values: validated.values, digest: validated.digest };
}

/** The code-owned key inventory a pack must cover: no more, no fewer. */
function catalog() {
  return { toolNames: [...TOOL_NAMES], compactDomains: Object.keys(COMPACT_GROUPS), promptNames: [...MCP_PROMPT_NAMES] };
}

function badRequest(res, error) {
  const invalid = ["PROMPT_BASE_INVALID", "PROMPT_INVALID_PACK", "INVALID_OVERRIDE_KEY"].includes(error?.code);
  const status = error?.status ?? (invalid ? 422 : 400);
  const code = error?.reason ?? error?.code ?? "BAD_REQUEST";
  res.status(status).json({ error: code, detail: String(error?.detail ?? error?.message ?? error) });
}

function resultCode(result) {
  if (result.ok) return 200;
  if (result.code === "PROMPT_STALE_REVISION") return 409;
  if (result.code === "PROMPT_STALE_OVERRIDE") return 409;
  if (result.code === "PROMPT_OVERRIDE_MISMATCH") return 422;
  if (result.code === "PROMPT_OVERRIDE_UNUSABLE") return 422;
  if (result.code === "PROMPT_UNKNOWN_REVISION") return 404;
  if (result.code === "PROMPT_STORE_IO") return 503;
  if (result.code === "PROMPT_INVALID_PACK") return 422;
  return 400;
}

export function registerPromptRegistryRoutes(router, { store, service, requireAdmin, requireCsrf }) {
  if (service === null || typeof service?.publishBase !== "function") return;
  const json = express.json({ limit: BODY_LIMIT, type: ["application/json", "application/*+json"] });

  const state = () => {
    const status = store.status();
    return {
      status: status.status,
      reasonCode: status.reasonCode ?? null,
      revision: status.revision,
      baseRevision: status.baseRevision,
      runtimeRevision: status.runtimeRevision,
      baseDigest: status.baseDigest,
      bundledBaseDigest: status.bundledBaseDigest,
      effectiveDigest: status.effectiveDigest,
      overrideCount: status.overrideCount,
      ignoredOverrideCount: status.ignoredOverrideCount,
      drift: status.drift,
      shadowedKeys: store.snapshot().shadowedKeys,
      tuning: store.snapshot().tuning,
      overrides: store.snapshot().overrides,
      history: store.history().map((entry) => ({
        revision: entry.revision,
        kind: entry.kind,
        packDigest: entry.packDigest,
        at: entry.at,
        reason: entry.reason,
      })),
    };
  };

  router.get(`${BASE}/state`, requireAdmin, noStore, (_req, res) => {
    res.json(state());
  });

  // The CSRF token for a JSON client: it is only reachable with an Admin session.
  router.get(`${BASE}/session`, requireAdmin, noStore, (req, res) => {
    res.json({ csrf: req.adminSession.csrf, revision: store.status().revision });
  });

  router.post(`${BASE}/base/preview`, requireAdmin, noStore, json, requireCsrf, async (req, res) => {
    try {
      const preview = await service.previewBase({ pack: packFromBody(req.body) });
      res.status(200).json(preview);
    } catch (error) {
      badRequest(res, error);
    }
  });

  router.post(`${BASE}/base/publish`, requireAdmin, noStore, json, requireCsrf, async (req, res) => {
    try {
      const result = await service.publishBase({
        expectedRevision: req.body?.expectedRevision,
        pack: packFromBody(req.body),
        sourceCommit: typeof req.body?.sourceCommit === "string" ? req.body.sourceCommit.slice(0, 64) : null,
        reason: req.body?.reason,
        resetOverriddenKeys: Array.isArray(req.body?.resetOverriddenKeys) ? req.body.resetOverriddenKeys.filter((key) => typeof key === "string").slice(0, 64) : [],
        expectedOverrideValues: req.body?.expectedOverrideValues && typeof req.body.expectedOverrideValues === "object" ? req.body.expectedOverrideValues : {},
      });
      res.status(resultCode(result)).json(result.ok ? { ...result, state: state() } : result);
    } catch (error) {
      badRequest(res, error);
    }
  });

  router.post(`${BASE}/override/preview`, requireAdmin, noStore, json, requireCsrf, async (req, res) => {
    try {
      const preview = await service.previewOverride({
        set: req.body?.set ?? {},
        removeKeys: Array.isArray(req.body?.removeKeys) ? req.body.removeKeys : [],
        tuning: req.body?.tuning ?? {},
      });
      res.status(200).json(preview);
    } catch (error) {
      badRequest(res, error);
    }
  });

  router.post(`${BASE}/override/publish`, requireAdmin, noStore, json, requireCsrf, async (req, res) => {
    try {
      const result = await service.publishOverride({
        expectedRevision: req.body?.expectedRevision,
        set: req.body?.set ?? {},
        removeKeys: Array.isArray(req.body?.removeKeys) ? req.body.removeKeys : [],
        tuning: req.body?.tuning ?? {},
        reason: req.body?.reason,
      });
      res.status(resultCode(result)).json(result.ok ? { ...result, state: state() } : result);
    } catch (error) {
      badRequest(res, error);
    }
  });

  router.post(`${BASE}/override/reset`, requireAdmin, noStore, json, requireCsrf, async (req, res) => {
    try {
      const result = await service.publishOverride({
        expectedRevision: req.body?.expectedRevision,
        set: {},
        removeKeys: Array.isArray(req.body?.keys) ? req.body.keys : [],
        tuning: req.body?.tuning ?? {},
        reason: req.body?.reason,
      });
      res.status(resultCode(result)).json(result.ok ? { ...result, state: state() } : result);
    } catch (error) {
      badRequest(res, error);
    }
  });

  router.post(`${BASE}/base/adopt-bundled`, requireAdmin, noStore, json, requireCsrf, async (req, res) => {
    try {
      const result = await service.adoptBundled({ expectedRevision: req.body?.expectedRevision, reason: req.body?.reason });
      res.status(resultCode(result)).json(result.ok ? { ...result, state: state() } : result);
    } catch (error) {
      badRequest(res, error);
    }
  });

  router.post(`${BASE}/rollback`, requireAdmin, noStore, json, requireCsrf, async (req, res) => {
    try {
      const result = await service.rollback({
        expectedRevision: req.body?.expectedRevision,
        targetRevision: req.body?.targetRevision,
        reason: req.body?.reason,
      });
      res.status(resultCode(result)).json(result.ok ? { ...result, state: state() } : result);
    } catch (error) {
      badRequest(res, error);
    }
  });

  router.post(`${BASE}/repair`, requireAdmin, noStore, json, requireCsrf, async (req, res) => {
    try {
      const result = await service.repair({ expectedRevision: req.body?.expectedRevision, reason: req.body?.reason });
      res.status(resultCode(result)).json(result.ok ? { ...result, state: state() } : result);
    } catch (error) {
      badRequest(res, error);
    }
  });
}
