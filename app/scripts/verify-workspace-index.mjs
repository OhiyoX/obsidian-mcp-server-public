import fs from "node:fs/promises";
import path from "node:path";

const data = path.resolve(process.env.DATA_PATH || "/data");
const index = JSON.parse(await fs.readFile(path.join(data, "index", "retrieval-index.json"), "utf8"));
const keys = Object.keys(index.notes || {});
const legacy = keys.filter((key) => /^(?:00-System|10-Inbox|20-Memory|30-Knowledge|40-Projects|50-Ops|60-Skills|70-Todos|80-Maps|90-Archive)\//.test(key));
const workspace = keys.filter((key) => key.startsWith("_Workspace/"));
const duplicate = keys.filter((key) => key.startsWith("_Workspace/") && keys.includes(key.slice("_Workspace/".length)));
const report = { notes: keys.length, workspaceNotes: workspace.length, legacyNotes: legacy.length, duplicatePaths: duplicate.length };
console.log(JSON.stringify(report));
if (legacy.length || duplicate.length || !workspace.length) process.exitCode = 1;
