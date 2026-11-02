// Admin plane — Simplified Chinese catalog (the default and the fallback).
//
// Copy is byte-identical to the literals the Admin renderers used before i18n, so
// the prototype-parity gate still compares the same Chinese face. Keys use the
// `adm.` prefix so that a key is never confused with an audit action value such as
// `admin.login` (those stay data, not copy).
import core from "./zh-CN.core.js";
import pages from "./zh-CN.pages.js";
import subjectAuthz from "./zh-CN.subject-authz.js";
import vaults from "./zh-CN.vaults.js";
import policy from "./zh-CN.policy.js";

// Admin copy is split by area (shell / router / shared vocabulary vs. pages vs. the
// Vault 与 Git surface) so no single catalog file grows past the architecture line
// budget; the lookup surface is unchanged.
export default Object.freeze({ ...core, ...pages, ...vaults, ...policy, ...subjectAuthz });
