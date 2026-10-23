import path from "node:path";
import { vaultLayout } from "./vault-layout.js";

export function parseBool(value) {
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseNumber(value, fallback) {
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseBytes(value) {
  const match = String(value).trim().toLowerCase().match(/^(\d+)(b|kb|mb|gb)?$/);
  if (!match) return 10 * 1024 * 1024;
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2] || "b";
  return amount * { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[unit];
}

// `DATA_PATH` owns the server's runtime state (sessions, trash, history, index). Production and the
// container always set it explicitly; this default only serves local runs, and it must not resolve to a
// drive root on Windows: `path.resolve("/data")` becomes `<cwd drive>:\data`, so a local `npm test` run
// from `D:\` used to leave a stray `D:\data` behind. On win32 the default is therefore `<app>/data`
// (already gitignored), independent of the working directory. Exported so the rule can be unit-tested on
// every platform.
export function defaultDataPath(platform = process.platform, appDir = path.resolve(import.meta.dirname, "..")) {
  return platform === "win32" ? path.join(appDir, "data") : "/data";
}

export const VAULT = path.resolve(process.env.VAULT_PATH || "/vault");
export const DATA_PATH = path.resolve(process.env.DATA_PATH || defaultDataPath());
export const TRASH_PATH = path.resolve(process.env.TRASH_PATH || path.join(DATA_PATH, "trash"));
export const HISTORY_PATH = path.resolve(process.env.HISTORY_PATH || path.join(DATA_PATH, "history"));
// Web multi-Vault configuration. These two helpers are the ONE place the process reads
// `WEB_VAULTS_ROOT` / `WEB_DEFAULT_VAULT` (W0-A inventory §1.7, contract §4.1) — every consumer
// derives from them instead of touching the environment itself. They are functions, not frozen
// constants, because the three consumers evaluate them at their own module load exactly as before
// this convergence (so nothing about the module-load ordering semantics changes); each consumer
// keeps its own (frozen) fallback derivation.
export function configuredWebVaultsRoot() {
  return String(process.env.WEB_VAULTS_ROOT || "").trim();
}

export function configuredWebDefaultVault() {
  return String(process.env.WEB_DEFAULT_VAULT || "").trim();
}
// W2 (#437) — Vault hot discovery + admission. EXPLICITLY OFF by default: without it the process
// keeps the pre-W2 behaviour (plain registry refresh, no admission gate, no `vault-admissions.json`).
// When enabled, discovery is gated by the persisted admission record and a missing/corrupt record
// fails closed instead of opening Vaults (contract §2.2/§2.3).
export const VAULT_DISCOVERY_ENABLED = parseBool(process.env.VAULT_DISCOVERY_ENABLED || "false");
// The ONE admission file (contract §2.2: 唯一权威文件 `DATA_PATH/vault-admissions.json`).
export const VAULT_ADMISSIONS_PATH = path.resolve(process.env.VAULT_ADMISSIONS_PATH || path.join(DATA_PATH, "vault-admissions.json"));
// W2FIX2 (#437 RETURN item 1): the independent MANAGED-MODE ENROLLMENT sentinel. It records only
// "this data root is under admission management" + the trusted identity bindings/generations, so a
// lost `vault-admissions.json` can never be re-read as "never managed". It carries no admission
// decision and is never consulted to grant one.
export const VAULT_ADMISSION_ENROLLMENT_PATH = path.resolve(process.env.VAULT_ADMISSION_ENROLLMENT_PATH || path.join(DATA_PATH, "vault-admission-enrollment.json"));
// W4 (#437) — the two AUTOMATIC triggers (watcher / periodic fallback) scheduling parameters.
// Frozen (Codex ruling 2026-10-09): debounce 500ms, longest merge wait 5s, periodic default 60s in the
// 30–900s operator range, failure backoff capped at 900s. They are clamped here (the ONE place the
// process reads the environment), and they only ever take effect when `VAULT_DISCOVERY_ENABLED` is on.
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const VAULT_DISCOVERY_DEBOUNCE_MS = clamp(parseInteger(process.env.VAULT_DISCOVERY_DEBOUNCE_MS, 500), 50, 5000);
export const VAULT_DISCOVERY_MAX_COALESCE_MS = Math.max(
  VAULT_DISCOVERY_DEBOUNCE_MS,
  clamp(parseInteger(process.env.VAULT_DISCOVERY_MAX_COALESCE_MS, 5000), 500, 60_000),
);
export const VAULT_DISCOVERY_PERIODIC_SECONDS = clamp(parseInteger(process.env.VAULT_DISCOVERY_PERIODIC_SECONDS, 60), 30, 900);
export const VAULT_DISCOVERY_PERIODIC_MAX_SECONDS = Math.max(
  VAULT_DISCOVERY_PERIODIC_SECONDS,
  clamp(parseInteger(process.env.VAULT_DISCOVERY_PERIODIC_MAX_SECONDS, 900), 30, 900),
);
export const READ_ONLY = parseBool(process.env.OBSIDIAN_READ_ONLY || "false");
export const DEFAULT_SEARCH_LIMIT = parseInteger(process.env.DEFAULT_SEARCH_LIMIT, 25);
export const MAX_SEARCH_LIMIT = parseInteger(process.env.MAX_SEARCH_LIMIT, 200);
export const MAX_LIST_ENTRIES = parseInteger(process.env.MAX_LIST_ENTRIES, 1000);
export const MAX_READ_BYTES = parseBytes(process.env.MAX_READ_BYTES || "10mb");
// Web asset upload ceiling (U30 contract A2). Defaults to MAX_READ_BYTES and is always
// clamped to it: the read route (`GET /api/web/v1/asset` -> `resolveWebAttachment`) serves
// the file through `MAX_READ_BYTES`, so a larger upload ceiling would create attachments
// that were written successfully but can never be read back.
export const WEB_ASSET_MAX_BYTES = Math.min(parseBytes(process.env.WEB_ASSET_MAX_BYTES || MAX_READ_BYTES), MAX_READ_BYTES);
// Vault-relative directory for Web-dropped attachments (contract A2 "目标目录策略").
export const WEB_ATTACHMENT_FOLDER = String(process.env.WEB_ATTACHMENT_FOLDER || "attachments").trim() || "attachments";
export const MAX_TRANSFER_BYTES = parseBytes(process.env.MAX_TRANSFER_BYTES || "100mb");
export const MAX_INLINE_TRANSFER_BYTES = Math.min(MAX_TRANSFER_BYTES, parseBytes(process.env.MAX_INLINE_TRANSFER_BYTES || "5mb"));
export const TRANSFER_CHUNK_BYTES = Math.max(64 * 1024, Math.min(4 * 1024 * 1024, parseBytes(process.env.TRANSFER_CHUNK_BYTES || "1mb")));
export const TRANSFER_TTL_MS = Math.max(60_000, parseInteger(process.env.TRANSFER_TTL_MS, 24 * 60 * 60 * 1000));
export const MAX_ARCHIVE_ENTRIES = Math.max(1, parseInteger(process.env.MAX_ARCHIVE_ENTRIES, 1000));
export const MAX_ARCHIVE_BYTES = parseBytes(process.env.MAX_ARCHIVE_BYTES || "100mb");
export const MAX_ARCHIVE_UNCOMPRESSED_BYTES = parseBytes(process.env.MAX_ARCHIVE_UNCOMPRESSED_BYTES || "250mb");
export const OBSIDIAN_TIMEZONE = process.env.OBSIDIAN_TIMEZONE || "Asia/Shanghai";
export const VERSION_HISTORY_ENABLED = parseBool(process.env.VERSION_HISTORY_ENABLED || "true");
export const MAX_VERSIONS_PER_FILE = parseInteger(process.env.MAX_VERSIONS_PER_FILE, 50);
export const GIT_ENABLED = parseBool(process.env.GIT_ENABLED || "false");
export const GIT_AUTO_COMMIT = parseBool(process.env.GIT_AUTO_COMMIT || "false");
export const GIT_AUTO_PUSH = parseBool(process.env.GIT_AUTO_PUSH || "false");
export const GIT_COMMIT_DEBOUNCE_SECONDS = Math.max(5, parseInteger(process.env.GIT_COMMIT_DEBOUNCE_SECONDS, 180));
export const GIT_COMMIT_MAX_DELAY_SECONDS = Math.max(1, parseInteger(process.env.GIT_COMMIT_MAX_DELAY_SECONDS, 900));
export const GIT_AUTO_COMMIT_SWEEP = parseBool(process.env.GIT_AUTO_COMMIT_SWEEP || "true");
export const GIT_SWEEP_INTERVAL_SECONDS = Math.max(30, parseInteger(process.env.GIT_SWEEP_INTERVAL_SECONDS, 900));
export const GIT_AUTHOR_NAME = process.env.GIT_AUTHOR_NAME || "Obsidian MCP";
export const GIT_AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL || "obsidian-mcp@local";
export const GIT_REMOTE = process.env.GIT_REMOTE || "origin";
export const GIT_BRANCH = process.env.GIT_BRANCH || "";
export const RETRIEVAL_INDEX_PATH = path.resolve(process.env.RETRIEVAL_INDEX_PATH || path.join(DATA_PATH, "index", "retrieval-index.json"));
export const RETRIEVAL_CHUNK_SIZE = Math.max(400, parseInteger(process.env.RETRIEVAL_CHUNK_SIZE, 1400));
export const RETRIEVAL_CHUNK_OVERLAP = Math.max(0, Math.min(RETRIEVAL_CHUNK_SIZE / 2, parseInteger(process.env.RETRIEVAL_CHUNK_OVERLAP, 180)));
export const RETRIEVAL_AUTO_EMBED = parseBool(process.env.RETRIEVAL_AUTO_EMBED ?? "true");
export const RETRIEVAL_REFRESH_DEBOUNCE_MS = Math.max(100, parseInteger(process.env.RETRIEVAL_REFRESH_DEBOUNCE_MS, 1000));
export const EMBEDDING_PROVIDER = String(process.env.EMBEDDING_PROVIDER || "disabled").trim().toLocaleLowerCase();
export const EMBEDDING_BASE_URL = String(process.env.EMBEDDING_BASE_URL || "").replace(/\/+$/, "");
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "qwen3-embedding-0.6b-q8";
export const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY || "";
export const EMBEDDING_TIMEOUT_MS = Math.max(1000, parseInteger(process.env.EMBEDDING_TIMEOUT_MS, 30000));
export const EMBEDDING_BATCH_SIZE = Math.max(1, Math.min(64, parseInteger(process.env.EMBEDDING_BATCH_SIZE, 32)));
export const EMBEDDING_INDEX_CONCURRENCY = Math.max(1, Math.min(16, parseInteger(process.env.EMBEDDING_INDEX_CONCURRENCY, 4)));
export const EMBEDDING_EDGE_PROVIDER = String(process.env.EMBEDDING_EDGE_PROVIDER || EMBEDDING_PROVIDER).trim().toLocaleLowerCase();
export const EMBEDDING_EDGE_BASE_URL = String(process.env.EMBEDDING_EDGE_BASE_URL || "").replace(/\/+$/, "");
export const EMBEDDING_EDGE_MODEL = process.env.EMBEDDING_EDGE_MODEL || EMBEDDING_MODEL;
export const EMBEDDING_EDGE_API_KEY = process.env.EMBEDDING_EDGE_API_KEY || "";
export const EMBEDDING_EDGE_TIMEOUT_MS = Math.max(250, parseInteger(process.env.EMBEDDING_EDGE_TIMEOUT_MS, 1500));
export const EMBEDDING_EDGE_HEALTH_INTERVAL_MS = Math.max(1000, parseInteger(process.env.EMBEDDING_EDGE_HEALTH_INTERVAL_MS, 10000));
export const EMBEDDING_EDGE_REGISTRY_URL = String(process.env.EMBEDDING_EDGE_REGISTRY_URL || "").replace(/\/+$/, "");
export const EMBEDDING_EDGE_REGISTRY_API_KEY = process.env.EMBEDDING_EDGE_REGISTRY_API_KEY || EMBEDDING_API_KEY;
export const MEMORY_PATH = process.env.MEMORY_PATH || vaultLayout.memory;
export const SKILLS_PATH = process.env.SKILLS_PATH || vaultLayout.skills;

export const EXCLUDED_DIRS = new Set([".git", "node_modules", ".obsidian-mcp-trash"]);

export const OBSIDIAN_ACCEPTED_EXTENSIONS = new Set([
  ".md",
  ".base",
  ".canvas",
  ".avif",
  ".bmp",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
  ".flac",
  ".m4a",
  ".mp3",
  ".ogg",
  ".wav",
  ".webm",
  ".3gp",
  ".mkv",
  ".mov",
  ".mp4",
  ".ogv",
  ".pdf",
]);

export const TEXT_FILE_EXTENSIONS = new Set([".md", ".base", ".canvas", ".json", ".txt", ".css", ".html", ".xml", ".csv", ".tsv"]);

export const TOOL_NAMES = [
  "agent_bootstrap",
  "server_info",
  "get_note",
  "pull_note_file",
  "get_metadata",
  "list_notes",
  "list_files",
  "list_recent",
  "search_notes",
  "get_file",
  "pull_file",
  "write_file",
  "start_file_upload",
  "file_upload_status",
  "upload_file_chunk",
  "cancel_file_upload",
  "create_archive",
  "inspect_archive",
  "read_archive_entry",
  "extract_archive",
  "get_canvas",
  "write_canvas",
  "write_note",
  "append_to_note",
  "patch_note",
  "replace_in_note",
  "manage_frontmatter",
  "list_tags",
  "manage_tags",
  "move_note",
  "delete_note",
  "list_trash",
  "restore_from_trash",
  "delete_trash_entry",
  "list_versions",
  "restore_version",
  "delete_version",
  "manage_folders",
  "get_backlinks",
  "get_graph",
  "get_unresolved_links",
  "get_orphans",
  "get_deadends",
  "list_tasks",
  "update_task",
  "daily_note",
  "list_templates",
  "create_from_template",
  "list_properties",
  "list_aliases",
  "rename_property",
  "set_property_type",
  "list_bases",
  "get_base",
  "write_base",
  "patch_base",
  "create_base_entry",
  "query_base",
  "list_base_views",
  "git_status",
  "git_diff",
  "git_log",
  "git_commit",
  "git_pull",
  "git_push",
  "index_status",
  "reindex_vault",
  "recall",
  "find_related",
  "get_note_context",
  "graph_health",
  "suggest_links",
  "memory_capture",
  "memory_recall",
  "skill_list",
  "skill_match",
  "skill_validate",
  "skill_export",
  "skill_import",
  "get_publish_status",
  "manage_publish",
  "plan_note_changes",
  "plan_move_note",
  "plan_delete_note",
  "plan_restore_version",
  "plan_restore_from_trash",
  "get_note_plan",
  "apply_note_plan",
  "get_note_version",
  "compare_note_versions",
];
