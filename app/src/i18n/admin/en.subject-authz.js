// Admin plane — the subject drawer's scheduled-access section (2026-10-31; moved onto the per-Vault
// constraints on 2026-11-09, read-only) — English copy.
export default Object.freeze({
  "adm.subjectAuthz.title": "Scheduled access",
  "adm.subjectAuthz.help": "This only adds a restriction on top of the access this subject already has; it never widens it, and the admin plane itself is not governed by constraints.",
  "adm.subjectAuthz.unrestricted": "Not restricted by scheduled access · no constraint names this subject, so it keeps its existing access",
  "adm.subjectAuthz.stateAllowed": "allowed now",
  "adm.subjectAuthz.stateRestricted": "restricted now",
  "adm.subjectAuthz.stateDisabled": "disabled",
  "adm.subjectAuthz.view": "view",
  "adm.subjectAuthz.frozen": "Read-only: a subject joins a constraint on the {href} — this section lists the constraints that name it and configures nothing.",
  "adm.subjectAuthz.unavailable": "The constraint store is not available: the document cannot be read, so this section cannot say which constraints name this subject.",
});
