import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DATA_PATH } from "./config.js";
import { MCP_SERVER_VERSION } from "./server-config.js";

// `scripts/nas_deploy.py` writes this manifest on every apply and rollback. It
// lives in the read-write data volume the container mounts as DATA_PATH, which
// keeps the deployed release identity visible to the running service without
// adding a Git file that a release tag could never contain.
const MANIFEST_FILE = "deployed-version.json";
let cached = { key: "", value: null };

function manifestPath() {
  return path.join(DATA_PATH, MANIFEST_FILE);
}

function textOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readManifest(file) {
  let key;
  try {
    const stats = statSync(file);
    if (!stats.isFile()) return null;
    key = `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return null;
  }
  if (cached.key === key) return cached.value;
  let value = null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const version = textOrNull(parsed?.version);
    if (version) {
      value = { version, commit: textOrNull(parsed?.commit), deployedAt: textOrNull(parsed?.deployedAt), source: "deploy" };
    }
  } catch {
    value = null;
  }
  cached = { key, value };
  return value;
}

/**
 * Release identity of the running service. A deployment manifest wins; local
 * runs and pre-pipeline checkouts fall back to MCP_SERVER_VERSION.
 */
export function deployedVersion() {
  return readManifest(manifestPath()) || { version: MCP_SERVER_VERSION, commit: null, deployedAt: null, source: "config" };
}

/**
 * Format deploy time into the process clock plus the original ISO string.
 * Production runs UTC, so `local` is `YYYY-MM-DD HH:mm:ss +00:00` there.
 * The settings footer does not display this string: the browser rewrites it
 * to Beijing time from the raw ISO. `iso` is returned unchanged.
 * @param {string|null} isoString - ISO 8601 UTC timestamp or null
 * @returns {{ iso: string|null, local: string|null, label: string }}
 */
export function formatDeployTime(isoString) {
  if (!isoString || typeof isoString !== "string") {
    return { iso: null, local: null, label: "未部署 (本地运行)" };
  }

  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) {
      return { iso: null, local: null, label: "未部署 (本地运行)" };
    }

    // Format: YYYY-MM-DD HH:mm:ss ±HH:MM
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");

    // Timezone offset in minutes, convert to ±HH:MM format
    const offsetMinutes = -date.getTimezoneOffset();
    const offsetSign = offsetMinutes >= 0 ? "+" : "-";
    const offsetHours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, "0");
    const offsetMins = String(Math.abs(offsetMinutes) % 60).padStart(2, "0");
    const offsetStr = `${offsetSign}${offsetHours}:${offsetMins}`;

    const local = `${year}-${month}-${day} ${hours}:${minutes}:${seconds} ${offsetStr}`;
    const label = `${local} (${isoString})`;

    return { iso: isoString, local, label };
  } catch {
    return { iso: null, local: null, label: "未部署 (本地运行)" };
  }
}

/**
 * Extract deploy time fields for endpoint responses.
 * Returns an object ready for spread into GET / and GET /healthz.
 */
export function deployTimeFields(release = deployedVersion()) {
  return {
    commit: release.commit,
    deployedAt: release.deployedAt,
    deployedAtFormatted: formatDeployTime(release.deployedAt),
  };
}

/** Compact single-line identity for UI chrome. */
export function versionLabel(release = deployedVersion()) {
  const commit = release.commit ? release.commit.slice(0, 8) : "";
  return commit ? `${release.version} · ${commit}` : release.version;
}

/**
 * Two-line face for the settings-dialog footer (#503). Line 1 keeps the release
 * identity; line 2 carries the deploy time explicitly labelled as the *server's*
 * clock, because `formatDeployTime` renders the process timezone (production runs
 * UTC, so `+00:00`). The browser replaces that line with Beijing time when the
 * raw ISO is present. A local run has no deploy time to attribute, so it keeps
 * the bare `未部署 (本地运行)` face instead of gaining a "server time" prefix.
 */
export function releaseFooterLines(release = deployedVersion()) {
  const formatted = formatDeployTime(release.deployedAt);
  const deployed = Boolean(formatted.iso && formatted.local);
  return {
    release: versionLabel(release),
    deploy: deployed ? `服务端时间 · ${formatted.local}` : formatted.label,
  };
}
