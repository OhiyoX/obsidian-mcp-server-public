// 定时授权, per-Vault constraints — the Admin routes (design §6.3, §6.5, §6.6, §6.9; plan Tasks 5-7).
//
// `GET {base}` is the constraint page (list, `?id=` drawer, `?edit=` / `?new=1` editor); the five
// writes are `POST {base}/{create,update,toggle,delete,plane}`. Attaching a subject is one of them:
// the editor's subject picker posts the whole draft to `update`, so no route starts from a subject.
//
// The GET reads NO store of its own: it renders `req.adminCatalog.constraintPage`, the model
// `buildCatalog` assembles from the one service the router received (`app/src/admin/catalog.js`).
// One request therefore reads one snapshot, and the page cannot disagree with the writes it offers.
// Without the service the POSTs answer 503 `authorization_admin_unavailable` and the page renders
// that fact instead of an empty list that looks healthy.
//
// Every POST is POST only, and the hard rules below hold as they did in Task 5:
//   * `requireAdmin` + `requireCsrf` run before anything else on every POST: no session is the
//     usual 303 to the login page, a missing or wrong token is a 403. Never a 404, and never an
//     unauthenticated oracle;
//   * a stale CAS answers 409 and hands the submitted draft back, because the editor must keep the
//     operator's typing on screen; a silently merged write is exactly what the CAS prevents;
//   * an unknown Vault answers 400 and names the Vault, so the operator can fix the row instead of
//     guessing which select failed;
//   * the service owns every default and every validity rule. This module decodes the form and
//     nothing else — an empty capability picker reaches the schema as `[]` and is refused there,
//     rather than being widened to "every capability" here.
//
// A refusal answers JSON to a client that asked for JSON (`Accept: application/json`, or no
// preference at all — a form post from a program keeps the shape Task 5 promised), and renders the
// page again for a browser (`Accept: text/html`). The operator pressed a button on an HTML page; a
// wall of JSON is a dead end, and a draft lost to a losing CAS is exactly what the CAS exists to
// prevent (§6.5).
import { AUTHORIZATION_LIMITS, AUTHORIZATION_CODES } from "../../authorization/schema.js";
import { AUTHORIZATION_STORE_CODES } from "../../authorization/store.js";
import { CONSTRAINT_ADMIN_CODES } from "../../authorization/constraint-admin.js";
import { t } from "../../i18n/context.js";
import { DEFAULT_BASE as PAGE_BASE, renderAuthzPage } from "../pages/authz-constraints.js";
import { draftOf, renderAuthzConstraintsEditor } from "../pages/authz-constraints-editor.js";
import { clean, listField } from "../http.js";
import {
  dateRangesFromFields, parseDateRangesText, parseWeeklyText, wallClockToInstant, weeklyFromFields,
} from "./access-policy.js";

/** Public default base URL. */
export const DEFAULT_BASE = PAGE_BASE;
/** The Auth Center router is mounted here in `server.js`. */
export const DEFAULT_MOUNT_PATH = "/admin/auth";
/** Route-level: this deployment injected no constraint service (the routes are still recorded). */
export const AUTHORIZATION_ADMIN_UNAVAILABLE = "authorization_admin_unavailable";

const { STALE_REVISION, REVISION_MISMATCH, WRITE_FAILED } = AUTHORIZATION_STORE_CODES;
const { UNKNOWN_VAULT, CONSTRAINT_NOT_FOUND } = CONSTRAINT_ADMIN_CODES;
const { INVALID_DOCUMENT, LIMIT_EXCEEDED, STATE_UNAVAILABLE } = AUTHORIZATION_CODES;

/** A service code becomes the HTTP status an editor can act on; an unmapped one is a bug. */
const REFUSAL_STATUS = new Map([
  [STALE_REVISION, 409],
  [REVISION_MISMATCH, 409],
  [UNKNOWN_VAULT, 400],
  [INVALID_DOCUMENT, 400],
  [LIMIT_EXCEEDED, 400],
  [CONSTRAINT_NOT_FOUND, 404],
  [STATE_UNAVAILABLE, 503],
  [WRITE_FAILED, 503],
]);

// ------------------------------------------------------------------ form decoding

/** The last value of a repeated field (a checkbox following its hidden `false` partner). */
function lastValue(value) {
  return Array.isArray(value) ? value[value.length - 1] : value;
}

/** `true`/`false` from a form; anything unrecognised stays `null` for the schema to refuse. */
function coerceBool(value) {
  const raw = lastValue(value);
  if (raw === true || raw === "true" || raw === "on" || raw === "1") return true;
  if (raw === false || raw === "false" || raw === "off" || raw === "0") return false;
  return null;
}

/**
 * The window half of a constraint, from the same form fields the frozen editor used (`timezone`,
 * `w_mon_from_0` …, `range_from_1` …, `startsAt`, `expiresAt`, or the text grammars).
 *
 * The parsers are the legacy module's own, on purpose: Task 6 keeps the prototype's weekday grid,
 * so both editors post the same field names with the same grammar. A day the parser cannot read is
 * passed through raw, so the schema refuses it instead of an interval disappearing in silence.
 */
function scheduleFrom(body) {
  const timezone = clean(lastValue(body.timezone), AUTHORIZATION_LIMITS.timezoneMaxLength)?.trim() ?? "";
  const structuredWeekly = weeklyFromFields(body);
  const weeklyText = typeof body.weekly === "string" ? body.weekly.trim() : "";
  const weekly = Object.keys(structuredWeekly).length
    ? structuredWeekly
    : (weeklyText ? parseWeeklyText(weeklyText) ?? weeklyText : {});
  const structuredRanges = dateRangesFromFields(body);
  const rangeText = typeof body.dateRanges === "string" ? body.dateRanges.trim() : "";
  const dateRanges = structuredRanges.length ? structuredRanges : (rangeText ? parseDateRangesText(rangeText) : []);
  const instant = (name) => {
    const raw = lastValue(body[name]);
    const text = typeof raw === "string" ? raw.trim() : "";
    return text ? wallClockToInstant(text, timezone) : null;
  };
  return { timezone, weekly, dateRanges, startsAt: instant("startsAt"), expiresAt: instant("expiresAt") };
}

/**
 * `decodeConstraintDraft(body)` → the service's draft `{label, subjects, mode, capabilities,
 * surfaces, vaultIds, schedule}`.
 *
 * `vaultIds: "all"` is the form's spelling of every Vault (`targets: null`, plan Task 4). An empty
 * picker stays `[]` so the schema refuses an empty branch; a `revoke` constraint is unrestricted by
 * the schema's own invariant (§8), so its selector fields are `null` here rather than `["all"]`.
 * `surfaces` is the one field an empty submission may leave unrestricted: Task 6's picker offers
 * operations, and the surfaces of an imported constraint are what they imported to, not a form field.
 */
/**
 * `decodeConstraintDraft(body)` → the service's draft `{label, subjects, mode, capabilities,
 * surfaces, vaultIds, schedule}`.
 *
 * `capabilities` is the union of the ticked operation chips and the operation picker's own field
 * (`addOperation`, design §6.3): the picker is one `<select>`, the chosen operations are the
 * checkboxes beside it, and the server joins them — the browser sends what the operator sees and
 * computes nothing. A `revoke` constraint is unrestricted by the schema's own invariant (§8).
 *
 * `vaultIds: "all"` is the form's spelling of every Vault (`targets: null`, plan Task 4). An empty
 * picker stays `[]` so the schema refuses an empty branch; `surfaces` is the one field an empty
 * submission may leave unrestricted — the page derives it from the picked operations' own surfaces.
 */
export function decodeConstraintDraft(body = {}) {
  const mode = lastValue(body.mode) === "revoke" ? "revoke" : "suspend";
  const scope = listField(body, "vaultIds");
  const surfaces = listField(body, "surfaces");
  return {
    label: clean(lastValue(body.label), AUTHORIZATION_LIMITS.labelMaxLength)?.trim() ?? "",
    subjects: listField(body, "subjects"),
    mode,
    capabilities: mode === "revoke" ? null : [...new Set([...listField(body, "capabilities"), ...listField(body, "addOperation")])],
    surfaces: mode === "revoke" || surfaces.length === 0 ? null : surfaces,
    vaultIds: mode === "revoke" || (scope.length === 1 && scope[0] === "all") ? null : scope,
    schedule: scheduleFrom(body),
  };
}

/**
 * The submitted draft, in the shape the editor renders.
 *
 * Built from the DECODED draft, not from the raw form: the decoder is the one place that knows the
 * form's grammar, and a refusal that re-read the body would be a second decoder that can disagree.
 * `scope` is the editor's spelling of the service's `vaultIds: null` (every Vault).
 */
export function editorDraftOf(draft, { enabled = true, id = null } = {}) {
  const schedule = draft?.schedule ?? {};
  return {
    id,
    label: draft?.label ?? "",
    enabled,
    mode: draft?.mode === "revoke" ? "revoke" : "suspend",
    subjects: Array.isArray(draft?.subjects) ? draft.subjects : [],
    // `null` is the editor's spelling of 「每一个界面」; a refused POST must not come back with the
    // operator's surface choice blank, or the resubmit it invites would widen the window.
    surfaces: Array.isArray(draft?.surfaces) ? draft.surfaces : null,
    capabilities: Array.isArray(draft?.capabilities) ? draft.capabilities : [],
    scope: draft?.vaultIds === null ? ["all"] : (Array.isArray(draft?.vaultIds) ? draft.vaultIds : []),
    timezone: schedule.timezone || "Asia/Shanghai",
    weekly: schedule.weekly && typeof schedule.weekly === "object" ? schedule.weekly : {},
    dateRanges: Array.isArray(schedule.dateRanges) ? schedule.dateRanges : [],
    startsAt: schedule.startsAt ?? null,
    expiresAt: schedule.expiresAt ?? null,
  };
}

/** A browser asked for a page; an explicit JSON preference wins over a mixed header. */
function wantsHtml(req) {
  const accept = String(req?.headers?.accept ?? "");
  return /text\/html/i.test(accept) && !/application\/json/i.test(accept);
}

// ------------------------------------------------------------------ registration

/**
 * `registerAuthorizationRoutes(router, { service, mountPath, requireAdmin, requireCsrf, actions })`.
 *
 * The five routes are registered even when no service was injected: the boundary inventory derives
 * its rows from the registered routes, and a recorded boundary that answers "unavailable" is
 * honest, while a boundary that disappears from the manifest is a hole. Returns `{ base }`.
 */
export function registerAuthorizationRoutes(router, {
  service = null,
  mountPath = DEFAULT_MOUNT_PATH,
  requireAdmin,
  requireCsrf,
  authorizationMode = null,
  view = null,
  actions = {},
} = {}) {
  const base = String(actions.base ?? `${mountPath}/authz`).replace(/\/+$/, "") || DEFAULT_BASE;
  // The frozen legacy page (design §7 step 2). The sidebar no longer points at it; this page offers it
  // as a plain read-only link, so history stays reachable without looking like a place to edit.
  const legacyPolicyBase = typeof actions.legacyPolicyBase === "string" && actions.legacyPolicyBase ? actions.legacyPolicyBase : null;
  const routeBase = base.startsWith(`${mountPath}/`) ? base.slice(mountPath.length) : base;

  const writes = {
    create: { withDraft: true, call: (input) => service.create({ expectedRevision: input.expectedRevision, draft: input.draft }) },
    update: { withDraft: true, call: (input) => service.update({ expectedRevision: input.expectedRevision, id: input.id, draft: input.draft }) },
    toggle: { withDraft: false, call: (input) => service.toggle({ expectedRevision: input.expectedRevision, id: input.id, enabled: input.enabled }) },
    delete: { withDraft: false, call: (input) => service.remove({ expectedRevision: input.expectedRevision, id: input.id }) },
    plane: { withDraft: false, call: (input) => service.setTemporalPlane({ expectedRevision: input.expectedRevision, enabled: input.enabled }) },
  };

  /**
   * The refusal body: the code, the field the operator must fix, the named Vault, and — on a stale
   * CAS — the draft. Task 5's routes and their tests promise this shape, so it stays for every
   * client that asks for JSON.
   */
  function refusalBody(result, input, status) {
    const body = { error: result.code };
    if (typeof result.path === "string" && result.path) body.path = result.path;
    if (result.code === UNKNOWN_VAULT) {
      const index = /^vaultIds\[(\d+)\]$/.exec(result.path ?? "")?.[1];
      const named = index === undefined ? undefined : input.draft?.vaultIds?.[Number(index)];
      if (typeof named === "string") body.vaultId = named;
    }
    // Design §6.5: the operator's typing survives a losing race, or the second save silently
    // loses it. The page layer (Task 6) renders this draft back into the form.
    if (status === 409 && input.draft !== null) body.draft = input.draft;
    return body;
  }

  /** The refusal in plain words, for a person instead of a client: what happened, and what to do. */
  function refusalCopy(code, { revision, path, vaultId }) {
    if (code === STALE_REVISION || code === REVISION_MISMATCH) {
      return t("adm.authz2.refusal.stale", { revision: revision === null ? t("adm.authz.notProvided") : String(revision) });
    }
    if (code === UNKNOWN_VAULT) return t("adm.authz2.refusal.unknownVault", { vaultId: vaultId ?? path ?? "" });
    if (code === CONSTRAINT_NOT_FOUND) return t("adm.authz2.refusal.missing");
    if (code === STATE_UNAVAILABLE || code === WRITE_FAILED) return t("adm.authz2.refusal.unavailable");
    return t("adm.authz2.refusal.invalid", { path: path ?? "" });
  }

  /** The shell every page of this module renders in (the sidebar and the drawer panel). */
  function sendPage(req, res, status, page, catalog) {
    const shell = typeof view?.renderAuthShell === "function"
      ? view.renderAuthShell({
        activeTab: "access-policy",
        session: req.adminSession,
        request: req,
        content: page.content,
        detailPanel: page.detailPanel ?? "",
        catalog: { theme: catalog?.theme, navCounts: catalog?.navCounts, navAttention: catalog?.navAttention },
      })
      : `${page.content}${page.detailPanel ?? ""}`;
    res.status(status).send(shell);
  }

  /**
   * `refuse(req, res, result, input)` — one refusal, to a browser as a page and to a client as JSON.
   *
   * The page carries the operator's own submission, so nothing typed is lost, and the CURRENT
   * revision, so one resubmit can win. The catalog is re-read here because the router builds one for
   * a GET only: a POST has no model, and a refusal that reused a model from another request would
   * state a revision that is already known to be stale.
   */
  async function refuse(req, res, result, input) {
    const status = REFUSAL_STATUS.get(result.code) ?? 500;
    const body = refusalBody(result, input, status);
    if (!wantsHtml(req) || typeof actions.catalog !== "function") {
      if (!res.headersSent) res.status(status).json(body);
      return;
    }
    let catalog = null;
    try {
      catalog = await actions.catalog(req);
    } catch {
      catalog = null;
    }
    const model = catalog?.constraintPage ?? null;
    if (model === null) {
      if (!res.headersSent) res.status(status).json(body);
      return;
    }
    let listed = null;
    try {
      listed = service?.list?.() ?? null;
    } catch {
      listed = null;
    }
    const current = {
      ...model,
      revision: Number.isInteger(listed?.revision) ? listed.revision : model.revision,
      timeConstraintsEnabled: listed?.timeConstraintsEnabled ?? model.timeConstraintsEnabled,
      constraints: Array.isArray(listed?.constraints) && listed.constraints.length ? listed.constraints : model.constraints,
    };
    const failure = refusalCopy(result.code, { revision: current.revision, path: body.path, vaultId: body.vaultId });
    const options = {
      base,
      now: catalog.now ?? Date.now(),
      authorizationMode,
      csrf: req.adminSession?.csrf ?? "",
      legacyBase: legacyPolicyBase,
      failure,
    };
    let page;
    if (input.draft !== null) {
      // The editor: the submitted draft and the fresh revision, so the second POST can succeed.
      const editing = input.id ? current.constraints.find((constraint) => constraint.id === input.id) ?? { id: input.id, label: input.draft.label } : null;
      page = renderAuthzConstraintsEditor(current, {
        ...options,
        constraint: editing,
        draft: editorDraftOf(input.draft, { enabled: input.enabled !== false, id: input.id || null }),
      });
    } else {
      // A toggle, delete or plane switch carries no draft: the list page states what happened, and
      // its own forms now carry the current revision.
      page = renderAuthzPage(current, options);
    }
    sendPage(req, res, status, page, catalog);
  }

  /**
   * `GET {base}` — the constraint page: the list, the `?id=` drawer and the `?edit=` / `?new=1`
   * editor, all server-rendered (CSP `default-src 'none'`: no script, no client-side verdict).
   *
   * The model is this request's catalog (`buildCatalog` → `constraintPage`), so the page reads no
   * store of its own. Without a catalog — no service wired, or a mount that built none — this
   * answers the same code its writes answer, never a thrown error and never a list that looks
   * healthy while nothing can be written.
   */
  router.get(routeBase, requireAdmin, async (req, res, next) => {
    try {
      const catalog = req.adminCatalog ?? null;
      if (catalog === null || !catalog.constraintPage) {
        res.status(503).json({ error: AUTHORIZATION_ADMIN_UNAVAILABLE });
        return;
      }
      const model = catalog.constraintPage;
      const query = req.query ?? {};
      const options = {
        base,
        query,
        now: catalog.now ?? Date.now(),
        authorizationMode,
        csrf: req.adminSession?.csrf ?? "",
        legacyBase: legacyPolicyBase,
      };
      const wanted = typeof query.edit === "string" && query.edit.trim() ? query.edit.trim() : "";
      const editing = wanted ? model.constraints.find((constraint) => constraint.id === wanted) ?? null : null;
      let page;
      if (wanted && editing === null) {
        // A bookmarked editor URL whose constraint is gone: the list says so, it does not open a form
        // that would create a second constraint under the old id.
        page = renderAuthzPage(model, { ...options, failure: t("adm.authz.missingTitle") });
      } else if ((wanted || query.new !== undefined) && model.status === "ready") {
        page = renderAuthzConstraintsEditor(model, {
          ...options,
          constraint: editing,
          draft: draftOf(editing, { vaults: model.vaults }),
        });
      } else {
        page = renderAuthzPage(model, options);
      }
      sendPage(req, res, 200, page, catalog);
    } catch (error) {
      next(error);
    }
  });

  for (const [endpoint, write] of Object.entries(writes)) {
    router.post(`${routeBase}/${endpoint}`, requireAdmin, requireCsrf, async (req, res, next) => {
      try {
        if (service === null) {
          res.status(503).json({ error: AUTHORIZATION_ADMIN_UNAVAILABLE });
          return;
        }
        const body = req.body ?? {};
        const revision = String(lastValue(body.expectedRevision) ?? "").trim();
        const input = {
          // An absent revision must not read as `0`: the service refuses a non-integer as stale.
          expectedRevision: revision === "" ? Number.NaN : Number(revision),
          draft: write.withDraft ? decodeConstraintDraft(body) : null,
          id: String(lastValue(body.id) ?? ""),
          enabled: coerceBool(body.enabled),
        };
        const result = await write.call(input);
        if (result.ok) {
          res.redirect(303, base);
          return;
        }
        await refuse(req, res, result, input);
      } catch (error) {
        next(error);
      }
    });
  }

  return { base };
}
