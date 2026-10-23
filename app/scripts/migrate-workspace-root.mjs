import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const ROOTS = ["00-System", "10-Inbox", "20-Memory", "30-Knowledge", "40-Projects", "50-Ops", "60-Skills", "70-Todos", "80-Maps", "90-Archive"];
const mode = process.argv.includes("--apply") ? "apply" : process.argv.includes("--repair-bases") ? "repair-bases" : process.argv.includes("--verify") ? "verify" : "dry-run";
const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const vault = path.resolve(argument("--vault", process.env.VAULT_PATH || "/vault"));
const data = path.resolve(argument("--data", process.env.DATA_PATH || "/data"));
const workspace = "_Workspace";
const stateFile = path.join(data, "publish", "state.json");
const manifestFile = path.resolve(argument("--manifest", path.join(data, "migrations", "workspace-root-20260923.json")));
const movedPath = (value) => {
  if (typeof value !== "string") return null;
  const first = value.split("/", 1)[0];
  return ROOTS.includes(first) && value.startsWith(`${first}/`) ? `${workspace}/${value}` : null;
};
const exists = async (file) => fs.access(file).then(() => true, () => false);

function rewriteLinks(markdown) {
  let inFence = false;
  let fence = "";
  let changed = 0;
  const lines = markdown.split(/(?<=\n)/);
  const result = lines.map((line) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!inFence) { inFence = true; fence = marker[1][0]; }
      else if (marker[1][0] === fence) inFence = false;
      return line;
    }
    if (inFence || /^    \S/.test(line)) return line;
    return line.replace(/(!?\[\[)([^\]\r\n]+)(\]\])/g, (full, open, body, close) => {
      const split = body.search(/[|#]/);
      const target = split < 0 ? body : body.slice(0, split);
      const next = movedPath(target);
      if (!next) return full;
      changed += 1;
      return `${open}${next}${split < 0 ? "" : body.slice(split)}${close}`;
    });
  });
  return { content: result.join(""), changed };
}

function rewriteBasePaths(source) {
  let changed = 0;
  const content = source.replace(/file\.inFolder\("([^"]+)"\)/g, (full, folder) => {
    const next = ROOTS.includes(folder) ? `${workspace}/${folder}` : movedPath(folder);
    if (!next) return full;
    changed += 1;
    return `file.inFolder("${next}")`;
  });
  return { content, changed };
}

async function vaultFiles(directory, extension) {
  const found = [];
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlink in migration scope: ${file}`);
      if (entry.isDirectory()) {
        if (current === vault && [".git", ".obsidian", ".stfolder", ".trash"].includes(entry.name)) continue;
        await visit(file);
      } else if (entry.isFile() && entry.name.endsWith(extension)) found.push(file);
    }
  }
  await visit(directory);
  return found;
}
const markdownFiles = (directory) => vaultFiles(directory, ".md");
const baseFiles = (directory) => vaultFiles(directory, ".base");

async function publishState() {
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  if (state.version !== 1 || !Array.isArray(state.records)) throw new Error("Unsupported Publish state format");
  const ids = new Set();
  const paths = new Set();
  for (const record of state.records) {
    const key = `${record.vaultId}\0${movedPath(record.path) || record.path}`;
    if (!record.id || !record.vaultId || !record.path || ids.has(record.id) || paths.has(key)) throw new Error("Invalid or duplicate Publish state record");
    ids.add(record.id);
    paths.add(key);
  }
  return state;
}

async function inventory() {
  const moves = [];
  const conflicts = [];
  for (const name of ROOTS) {
    const from = path.join(vault, name);
    const to = path.join(vault, workspace, name);
    if (await exists(from)) {
      if (await exists(to)) conflicts.push(`${name}: target exists`);
      moves.push({ from: name, to: `${workspace}/${name}` });
    } else if (!(await exists(to))) conflicts.push(`${name}: source and target both missing`);
  }
  if (await exists(path.join(vault, "_AI.md")) && await exists(path.join(vault, "_AI_README.md"))) conflicts.push("AI signpost target exists");
  for (const stale of ["90-System", "Templater相关", path.join("60-Skills", "Obsidian")]) {
    if (await exists(path.join(vault, stale))) conflicts.push(`${stale}: pre-refactor cleanup reappeared`);
  }
  const files = await markdownFiles(vault);
  let wikilinks = 0;
  let legacyTextHits = 0;
  for (const file of files) {
    const raw = await fs.readFile(file, "utf8");
    wikilinks += rewriteLinks(raw).changed;
    legacyTextHits += (raw.match(/(?<!_Workspace\/)(?:00-System|10-Inbox|20-Memory|30-Knowledge|40-Projects|50-Ops|60-Skills|70-Todos|80-Maps|90-Archive)\//g) || []).length;
  }
  let basePathRefs = 0;
  for (const file of await baseFiles(vault)) basePathRefs += rewriteBasePaths(await fs.readFile(file, "utf8")).changed;
  const state = await publishState();
  return { vault, workspaceRoot: workspace, moves, renameAi: await exists(path.join(vault, "_AI.md")), conflicts, markdownFiles: files.length, wikilinks, basePathRefs, legacyTextHits, publishRecords: state.records.length, publishMoves: state.records.filter((record) => movedPath(record.path)).length, indexPlan: "syncRetrievalIndex({force:true,embeddings:true}) removes stale paths" };
}

async function atomicWrite(file, content, mode = 0o644) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { mode });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function guide() {
  return `# AI / Agent Vault Guide\n\n这是一个可自由书写的普通 Obsidian Vault。\n\n结构化工作区入口：\n- [[_Workspace/80-Maps/Home|Workspace Home]]\n- [[_Workspace/00-System/Agent/AI 笔记规范|AI 与 MCP 笔记边界]]\n\n严格受管区域：\n- \`_Workspace/00-System/\`\n- \`_Workspace/20-Memory/\`\n- \`_Workspace/60-Skills/\`\n- \`_Workspace/80-Maps/\`\n\n\`_Workspace\` 中的其他目录属于统一工作区，但不因此自动采用严格 schema。Vault 根目录及其他个人/主题目录继续允许自由创建和编辑普通 Markdown。\n\n不要因为 Workspace 的存在自动搬动、重写或结构化普通笔记。\n`;
}

async function verify() {
  const report = await inventory();
  const stale = [];
  for (const name of ROOTS) if (await exists(path.join(vault, name))) stale.push(name);
  if (stale.length || report.conflicts.length || report.wikilinks || report.basePathRefs || report.publishMoves || !(await exists(path.join(vault, "_AI_README.md")))) {
    throw new Error(`Workspace verification failed: ${JSON.stringify({ stale, conflicts: report.conflicts, wikilinks: report.wikilinks, basePathRefs: report.basePathRefs, publishMoves: report.publishMoves })}`);
  }
  return { ...report, verified: true };
}

if (mode === "dry-run") {
  console.log(JSON.stringify(await inventory(), null, 2));
} else if (mode === "verify") {
  console.log(JSON.stringify(await verify(), null, 2));
} else if (mode === "repair-bases") {
  for (const name of ROOTS) if (await exists(path.join(vault, name))) throw new Error("Legacy root still exists; use --apply");
  for (const file of await baseFiles(vault)) {
    const raw = await fs.readFile(file, "utf8");
    const rewritten = rewriteBasePaths(raw);
    if (rewritten.changed) await atomicWrite(file, rewritten.content, (await fs.stat(file)).mode & 0o777);
  }
  console.log(JSON.stringify(await verify(), null, 2));
} else {
  const report = await inventory();
  if (report.conflicts.length) throw new Error(`Migration blocked: ${report.conflicts.join("; ")}`);
  if (!report.moves.length && !report.renameAi) throw new Error("Nothing to migrate; use --verify");
  await fs.mkdir(path.dirname(manifestFile), { recursive: true });
  if (await exists(manifestFile)) throw new Error(`Manifest already exists: ${manifestFile}`);
  const manifest = { version: 1, createdAt: new Date().toISOString(), vault, workspaceRoot: workspace, moves: report.moves, renameAi: report.renameAi, before: report };
  await atomicWrite(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  await fs.mkdir(path.join(vault, workspace), { recursive: true });
  for (const move of report.moves) await fs.rename(path.join(vault, move.from), path.join(vault, move.to));
  if (report.renameAi) await fs.rename(path.join(vault, "_AI.md"), path.join(vault, "_AI_README.md"));
  for (const file of await markdownFiles(vault)) {
    if (file === path.join(vault, "_AI_README.md")) continue;
    const raw = await fs.readFile(file, "utf8");
    const rewritten = rewriteLinks(raw);
    if (rewritten.changed) await atomicWrite(file, rewritten.content, (await fs.stat(file)).mode & 0o777);
  }
  for (const file of await baseFiles(vault)) {
    const raw = await fs.readFile(file, "utf8");
    const rewritten = rewriteBasePaths(raw);
    if (rewritten.changed) await atomicWrite(file, rewritten.content, (await fs.stat(file)).mode & 0o777);
  }
  await atomicWrite(path.join(vault, "_AI_README.md"), guide(), 0o644);
  const state = await publishState();
  for (const record of state.records) record.path = movedPath(record.path) || record.path;
  await atomicWrite(stateFile, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  console.log(JSON.stringify(await verify(), null, 2));
}
