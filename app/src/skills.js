import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { unzipSync, zipSync } from "fflate";
import { parseFrontmatter } from "./frontmatter.js";
import yaml from "js-yaml";
import {
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  SKILLS_PATH,
} from "./config.js";
import { inspectZipBuffer } from "./file-transfer.js";
// Wave D / D-intelligence: every managed Skills path is resolved against the *selected* Vault's
// runtime, not the primary facade (contract §29 intelligence/context/memory/skills lane, §10.1).
// `SKILLS_PATH` stays a Vault-relative layout constant, so the same call now reads/writes the
// Skills area of whichever Vault the request selected; a caller with no Vault selection keeps the
// legacy primary behaviour byte-for-byte (the request facade falls back to the primary runtime).
import {
  assertCanonicalInsideVault,
  atomicWriteFile,
  exists,
  fileRevision,
  readLimitedText,
  resolveVaultPath,
  toVaultPath,
} from "./vault-runtime/request-vault.js";

const PACKAGE_DIRS = new Set(["agents", "scripts", "references", "assets"]);
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function strings(value) {
  return (Array.isArray(value) ? value : value == null ? [] : [value]).map(String).map((item) => item.trim()).filter(Boolean);
}

function normalizeSkillInput(value) {
  const normalized = String(value || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) throw new Error("A skill name or path is required");
  if (normalized === "SKILL.md") return normalized;
  if (normalized.startsWith(`${SKILLS_PATH.replace(/\/$/, "")}/`)) return normalized;
  return `${SKILLS_PATH.replace(/\/$/, "")}/${normalized}`;
}

function packageEntryPath(value) {
  const normalized = String(value).replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:/i.test(normalized)) throw new Error(`Unsafe skill package entry: ${value}`);
  const clean = path.posix.normalize(normalized);
  if (clean === ".." || clean.startsWith("../") || clean.split("/").includes("..")) throw new Error(`Skill package path traversal denied: ${value}`);
  return clean;
}

function skillMetadata(frontmatter, fallbackName) {
  return {
    name: String(frontmatter.name || fallbackName || "").trim(),
    description: String(frontmatter.description || "").trim(),
    title: String(frontmatter.title || frontmatter.name || fallbackName || "").trim(),
    version: frontmatter.version == null && frontmatter.metadata?.version == null ? undefined : String(frontmatter.version ?? frontmatter.metadata.version),
    triggers: strings(frontmatter.triggers),
    allowedTools: String(frontmatter["allowed-tools"] || "").trim() || strings(frontmatter.allowed_tools).join(" ") || undefined,
    trusted: frontmatter.trusted === true,
    risk: frontmatter.risk == null ? undefined : String(frontmatter.risk),
    paths: strings(frontmatter.paths ?? frontmatter.globs),
    disableModelInvocation: frontmatter["disable-model-invocation"] === true,
  };
}

async function inventoryPackage(rootAbs) {
  const resources = [];
  let totalBytes = 0;
  async function visit(current) {
    for (const dirent of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(current, dirent.name);
      const rel = path.relative(rootAbs, abs).split(path.sep).join("/");
      if (dirent.isSymbolicLink()) {
        resources.push({ path: rel, type: "symlink", size: 0 });
        continue;
      }
      if (dirent.isDirectory()) {
        await visit(abs);
        continue;
      }
      if (!dirent.isFile()) continue;
      const stat = await fs.stat(abs);
      totalBytes += stat.size;
      resources.push({ path: rel, type: "file", size: stat.size, category: rel === "SKILL.md" ? "instructions" : rel.split("/")[0] });
    }
  }
  await visit(rootAbs);
  return { resources, totalBytes };
}

export async function validateSkillPackage(skillPath) {
  const requested = normalizeSkillInput(skillPath);
  let entryAbs = resolveVaultPath(requested);
  let stat = await fs.stat(entryAbs).catch(() => null);
  if (stat?.isDirectory()) entryAbs = path.join(entryAbs, "SKILL.md");
  if (!stat && !requested.toLowerCase().endsWith(".md")) entryAbs = resolveVaultPath(`${requested}/SKILL.md`);
  await assertCanonicalInsideVault(entryAbs);
  if (path.basename(entryAbs) !== "SKILL.md") throw new Error(`Canonical skill entry must be SKILL.md: ${toVaultPath(entryAbs)}`);
  const rootAbs = path.dirname(entryAbs);
  const rootPath = toVaultPath(rootAbs);
  const folderName = path.basename(rootAbs);
  let parsed = { data: {}, content: "" };
  let frontmatterError;
  try {
    parsed = parseFrontmatter(await readLimitedText(entryAbs));
  } catch (error) {
    frontmatterError = error;
  }
  const metadata = skillMetadata(parsed.data || {}, folderName);
  const { resources, totalBytes } = await inventoryPackage(rootAbs);
  const errors = [];
  const warnings = [];
  if (frontmatterError) errors.push(`SKILL.md frontmatter is invalid: ${frontmatterError.message}`);
  if (!metadata.name) errors.push("frontmatter name is required");
  else if (!SKILL_NAME.test(metadata.name) || metadata.name.length > 64) errors.push("name must be 1-64 lowercase letters, digits, and hyphens");
  if (metadata.name && metadata.name !== folderName) errors.push(`name must match package directory (${folderName})`);
  if (!metadata.description) errors.push("frontmatter description is required");
  else if (metadata.description.length > 1024) errors.push("description must be at most 1024 characters");
  if (!parsed.content.trim()) errors.push("SKILL.md instructions are required");
  if (parsed.content.split(/\r?\n/).length > 500) warnings.push("SKILL.md exceeds the recommended 500 lines; move detail into references/");
  if (Object.hasOwn(parsed.data || {}, "compatibility") && (typeof parsed.data.compatibility !== "string" || !parsed.data.compatibility.trim() || parsed.data.compatibility.length > 500)) errors.push("compatibility must be a non-empty string of at most 500 characters");
  if (Object.hasOwn(parsed.data || {}, "metadata")) {
    const metadataMap = parsed.data.metadata;
    if (!metadataMap || typeof metadataMap !== "object" || Array.isArray(metadataMap) || Object.values(metadataMap).some((value) => typeof value !== "string")) errors.push("metadata must be a mapping of string keys to string values");
  }
  if (Object.hasOwn(parsed.data || {}, "allowed-tools") && typeof parsed.data["allowed-tools"] !== "string") errors.push("allowed-tools must be a space-separated string");
  if (Object.hasOwn(parsed.data || {}, "disable-model-invocation") && typeof parsed.data["disable-model-invocation"] !== "boolean") errors.push("disable-model-invocation must be a boolean");
  if (resources.some((item) => item.type === "symlink")) errors.push("symbolic links are not allowed in skill packages");
  if (resources.length > MAX_ARCHIVE_ENTRIES) errors.push(`package exceeds MAX_ARCHIVE_ENTRIES (${MAX_ARCHIVE_ENTRIES})`);
  if (totalBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) errors.push(`package exceeds MAX_ARCHIVE_UNCOMPRESSED_BYTES (${MAX_ARCHIVE_UNCOMPRESSED_BYTES})`);
  const openaiPath = path.join(rootAbs, "agents", "openai.yaml");
  if (await exists(openaiPath)) {
    try {
      const agent = yaml.load(await readLimitedText(openaiPath));
      if (!agent || typeof agent !== "object" || Array.isArray(agent)) errors.push("agents/openai.yaml must contain a YAML mapping");
    } catch (error) {
      errors.push(`agents/openai.yaml is invalid: ${error.message}`);
    }
  }
  return {
    kind: "package",
    schema: "agent-skills/v1",
    path: rootPath,
    entryPath: toVaultPath(entryAbs),
    ...metadata,
    valid: errors.length === 0,
    errors,
    warnings: [...new Set(warnings)],
    resources,
    resourceCount: resources.length,
    totalBytes,
    compatibility: {
      standard: "Agent Skills",
      codex: true,
      cursor: true,
      notionFiles: true,
      openaiMetadata: await exists(openaiPath),
    },
    executionAuthorized: false,
  };
}

export async function listSkillPackages({ validOnly = false, limit = 200 } = {}) {
  const skillsRoot = resolveVaultPath(SKILLS_PATH);
  if (!(await exists(skillsRoot))) return { managedRoot: SKILLS_PATH, skills: [], truncated: false };
  await assertCanonicalInsideVault(skillsRoot);
  const entries = [];
  async function visit(current) {
    if (entries.length >= limit) return;
    for (const dirent of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (dirent.name.startsWith(".") || dirent.isSymbolicLink()) continue;
      const abs = path.join(current, dirent.name);
      if (dirent.isDirectory()) {
        if (dirent.name === "_packages") continue;
        const entry = path.join(abs, "SKILL.md");
        if (await exists(entry)) {
          const validation = await validateSkillPackage(toVaultPath(abs));
          if (!validOnly || validation.valid) entries.push(validation);
        } else await visit(abs);
      }
      if (entries.length >= limit) return;
    }
  }
  await visit(skillsRoot);
  return { managedRoot: SKILLS_PATH, skills: entries.slice(0, limit), truncated: entries.length >= limit };
}

export async function exportSkillPackage({ skill, destination, overwrite = false }) {
  const validation = await validateSkillPackage(skill);
  if (!validation.valid) throw new Error(`Skill package is invalid: ${validation.errors.join("; ")}`);
  const rootAbs = resolveVaultPath(validation.path);
  const destinationPath = destination || path.posix.join(SKILLS_PATH, "_packages", `${validation.name}${validation.version ? `-${validation.version}` : ""}.zip`);
  const destinationAbs = resolveVaultPath(destinationPath);
  if (path.extname(destinationAbs).toLowerCase() !== ".zip") throw new Error("Skill archive destination must end in .zip");
  if ((await exists(destinationAbs)) && !overwrite) throw new Error("Skill archive destination exists. Set overwrite=true to replace it.");
  const files = {};
  let totalBytes = 0;
  for (const resource of validation.resources) {
    if (resource.type !== "file") continue;
    const entry = packageEntryPath(path.posix.join(validation.name, resource.path));
    const data = await fs.readFile(path.join(rootAbs, ...resource.path.split("/")));
    totalBytes += data.length;
    if (totalBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) throw new Error(`Skill package exceeds MAX_ARCHIVE_UNCOMPRESSED_BYTES (${MAX_ARCHIVE_UNCOMPRESSED_BYTES})`);
    files[entry] = new Uint8Array(data);
  }
  const archive = Buffer.from(zipSync(files, { level: 6 }));
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error(`Skill archive exceeds MAX_ARCHIVE_BYTES (${MAX_ARCHIVE_BYTES})`);
  const manifest = inspectZipBuffer(archive);
  const written = await atomicWriteFile(destinationAbs, archive);
  return { path: toVaultPath(destinationAbs), skill: validation.name, schema: validation.schema, ...manifest, sha256: sha256(archive), revision: written.revision, executionAuthorized: false };
}

function packageFromArchive(manifest) {
  const files = manifest.entries.filter((entry) => !entry.directory).map((entry) => entry.path);
  const roots = new Set();
  for (const file of files) {
    const parts = file.split("/");
    if (file === "SKILL.md") roots.add("");
    else if (parts.at(-1) === "SKILL.md") roots.add(parts.slice(0, -1).join("/"));
  }
  if (roots.size !== 1) throw new Error("Skill ZIP must contain exactly one package root with SKILL.md");
  const root = [...roots][0];
  const prefix = root ? `${root}/` : "";
  const packageFiles = files.filter((file) => !root || file.startsWith(prefix));
  if (packageFiles.length !== files.length) throw new Error("Skill ZIP contains files outside its package root");
  return { root, prefix, files: packageFiles };
}

function validateImportedMetadata(skillMd, archiveFolder) {
  const parsed = parseFrontmatter(skillMd.toString("utf8"));
  const metadata = skillMetadata(parsed.data || {}, archiveFolder);
  const errors = [];
  if (!metadata.name || !SKILL_NAME.test(metadata.name) || metadata.name.length > 64) errors.push("frontmatter name must be 1-64 lowercase letters, digits, and hyphens");
  if (archiveFolder && metadata.name !== archiveFolder) errors.push(`name must match archive package directory (${archiveFolder})`);
  if (!metadata.description || metadata.description.length > 1024) errors.push("frontmatter description is required and must be at most 1024 characters");
  if (!parsed.content.trim()) errors.push("SKILL.md instructions are required");
  if (errors.length) throw new Error(`Invalid Skill package: ${errors.join("; ")}`);
  return metadata;
}

export async function importSkillPackage({ archivePath, dryRun = true }) {
  const archiveAbs = resolveVaultPath(archivePath);
  await assertCanonicalInsideVault(archiveAbs);
  const buffer = await fs.readFile(archiveAbs);
  const manifest = inspectZipBuffer(buffer);
  const packageInfo = packageFromArchive(manifest);
  const decoded = new Map(Object.entries(unzipSync(new Uint8Array(buffer))).map(([name, data]) => [packageEntryPath(name), Buffer.from(data)]));
  const skillEntry = `${packageInfo.prefix}SKILL.md`;
  const archiveFolder = packageInfo.root ? packageInfo.root.split("/").at(-1) : "";
  const metadata = validateImportedMetadata(decoded.get(skillEntry), archiveFolder);
  const destinationRoot = resolveVaultPath(path.posix.join(SKILLS_PATH, metadata.name));
  await assertCanonicalInsideVault(destinationRoot, { allowMissing: true });
  if (await exists(destinationRoot)) throw new Error(`Skill destination already exists: ${toVaultPath(destinationRoot)}`);
  const plans = packageInfo.files.map((entry) => {
    const relative = packageEntryPath(entry.slice(packageInfo.prefix.length));
    const top = relative.split("/")[0];
    const standard = relative === "SKILL.md" || PACKAGE_DIRS.has(top);
    return { entry, relative, path: `${toVaultPath(destinationRoot)}/${relative}`, standard, size: decoded.get(entry)?.length || 0 };
  });
  const result = { archivePath: toVaultPath(archiveAbs), destination: toVaultPath(destinationRoot), skill: metadata.name, schema: "agent-skills/v1", dryRun, files: plans, warnings: [], executionAuthorized: false };
  if (dryRun) return result;
  try {
    for (const plan of plans) {
      const data = decoded.get(plan.entry);
      if (!data) throw new Error(`ZIP decoder did not return expected entry: ${plan.entry}`);
      await atomicWriteFile(resolveVaultPath(plan.path), data);
    }
    const validation = await validateSkillPackage(toVaultPath(destinationRoot));
    if (!validation.valid) throw new Error(`Imported Skill failed validation: ${validation.errors.join("; ")}`);
    return { ...result, imported: plans.length, validation, revision: await fileRevision(path.join(destinationRoot, "SKILL.md")) };
  } catch (error) {
    await fs.rm(destinationRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
