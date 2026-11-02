// Admin plane — English catalog. Must carry exactly the keys of `zh-CN.js`
// (`test/i18n-admin-catalog.test.js`).
//
// Wording follows the same vocabulary the Web surface uses (sign in, Vault, keys)
// so an operator switching planes does not meet two names for one thing.
import core from "./en.core.js";
import pages from "./en.pages.js";
import subjectAuthz from "./en.subject-authz.js";
import vaults from "./en.vaults.js";
import policy from "./en.policy.js";

// Admin copy is split by area (shell / router / shared vocabulary vs. pages vs. the
// Vault 与 Git surface) so no single catalog file grows past the architecture line
// budget; the lookup surface is unchanged.
export default Object.freeze({ ...core, ...pages, ...vaults, ...policy, ...subjectAuthz });
