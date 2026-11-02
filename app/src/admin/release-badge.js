import { deployedVersion, formatDeployTime } from "../release-version.js";
// The Beijing label has ONE implementation, shared with the web bundle
// (`frontend/app/features/settings/deploy-time.js` re-exports it) so the two
// human-facing surfaces cannot drift apart. It lives under `src/` on purpose:
// the container mounts only `app/server.js` + `app/src`, so a runtime import from
// here into `frontend/` is `ERR_MODULE_NOT_FOUND` in production (window #22).
//
// Why it is rendered here (server-side) and not in the browser: the Admin plane
// runs no script — CSP is `default-src 'none'` with no `script-src` (see the
// note in `access-policy-view.js`), and the Admin UI v2 contract keeps the
// D0/CSP decision for a separate ruling. The API surfaces (`/healthz`,
// `server_info`) keep the raw UTC fields; only this human-facing badge gets the
// Beijing label. The raw ISO is still emitted as `data-deployed-at`, so a later
// client-side route can take over without changing this markup.
import { formatBeijingDeployLabel } from "../beijing-deploy-time.js";

function html(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/**
 * Generate the release badge HTML strip for admin UI chrome.
 * Returns a styled div showing version, commit, and deploy time in Beijing time.
 */
export function releaseBadgeHtml() {
  const release = deployedVersion();
  const formatted = formatDeployTime(release.deployedAt);
  const commitPart = release.commit ? `commit ${release.commit}` : "";
  // Beijing label from the raw ISO; fall back to the release label when there is
  // no usable timestamp (local run / unreadable manifest).
  const timePart = formatBeijingDeployLabel(formatted.iso) ?? formatted.label;
  const detail = [commitPart, timePart].filter(Boolean).join(" · ");
  const rawIso = formatted.iso ? ` data-deployed-at="${html(formatted.iso)}"` : "";
  return `<div class="release-badge muted" style="display:flex;justify-content:flex-end;align-items:center;gap:5px;font-size:11px;margin:0 0 8px">部署版本 <code>${html(release.version)}</code>${detail ? `<span${rawIso}>· ${html(detail)}</span>` : ""}</div>`;
}
