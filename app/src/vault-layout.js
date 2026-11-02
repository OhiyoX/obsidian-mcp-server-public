import path from "node:path";

export function normalizeWorkspaceRoot(value = "") {
  const raw = String(value).trim().replaceAll("\\", "/").replace(/\/+$/, "");
  if (!raw) return "";
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw new Error("VAULT_WORKSPACE_ROOT must be vault-relative");
  const segments = raw.split("/");
  if (segments.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw new Error("VAULT_WORKSPACE_ROOT contains an unsafe path segment");
  }
  return segments.join("/");
}

export function createVaultLayout(root = "") {
  const workspaceRoot = normalizeWorkspaceRoot(root);
  const join = (...parts) => path.posix.join(...[workspaceRoot, ...parts].filter(Boolean));
  return Object.freeze({
    workspaceRoot,
    system: join("00-System"),
    inbox: join("10-Inbox"),
    memory: join("20-Memory"),
    knowledge: join("30-Knowledge"),
    projects: join("40-Projects"),
    ops: join("50-Ops"),
    skills: join("60-Skills"),
    todos: join("70-Todos"),
    maps: join("80-Maps"),
    archive: join("90-Archive"),
    home: join("80-Maps", "Home.md"),
    aiGuide: workspaceRoot ? "_AI_README.md" : "_AI.md",
  });
}

const LEGACY_ROOTS = new Set(["00-System", "10-Inbox", "20-Memory", "30-Knowledge", "40-Projects", "50-Ops", "60-Skills", "70-Todos", "80-Maps", "90-Archive"]);

export function workspacePathForLegacy(notePath, layout = vaultLayout) {
  if (!layout.workspaceRoot || typeof notePath !== "string") return null;
  if (notePath.includes("\\") || notePath.split("/").some((part) => !part || part === "." || part === "..")) return null;
  const first = notePath.split("/", 1)[0];
  return LEGACY_ROOTS.has(first) && notePath.startsWith(`${first}/`)
    ? path.posix.join(layout.workspaceRoot, notePath)
    : null;
}

// Empty root keeps the current layout intact until a manifest-backed Vault move.
export const vaultLayout = createVaultLayout(process.env.VAULT_WORKSPACE_ROOT ?? "");
