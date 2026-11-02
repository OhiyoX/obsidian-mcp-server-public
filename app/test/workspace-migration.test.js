import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const roots = ["00-System", "10-Inbox", "20-Memory", "30-Knowledge", "40-Projects", "50-Ops", "60-Skills", "70-Todos", "80-Maps", "90-Archive"];
const script = path.resolve("scripts/migrate-workspace-root.mjs");

test("Workspace migration keeps Publish IDs and rewrites live links without changing historical code blocks", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-migration-"));
  const vault = path.join(temporary, "vault");
  const data = path.join(temporary, "data");
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [script, ...args, "--vault", vault, "--data", data], { encoding: "utf8" }));
  try {
    for (const root of roots) await fs.mkdir(path.join(vault, root), { recursive: true });
    await fs.mkdir(path.join(data, "publish"), { recursive: true });
    await fs.writeFile(path.join(vault, "_AI.md"), "old guide");
    await fs.writeFile(path.join(vault, "40-Projects", "note.md"), "# Note\n[[80-Maps/Home|Home]]\n```md\n[[40-Projects/note]]\n```\n");
    await fs.writeFile(path.join(vault, "80-Maps", "Home.md"), "[[40-Projects/note]]\n");
    await fs.writeFile(path.join(vault, "80-Maps", "Projects.base"), 'filters: file.inFolder("40-Projects")\n');
    await fs.writeFile(path.join(data, "publish", "state.json"), JSON.stringify({ version: 1, records: [{ id: "stable-id", vaultId: "vault", path: "40-Projects/note.md" }] }));
    const before = run("--dry-run");
    assert.equal(before.moves.length, 10);
    assert.equal(before.wikilinks, 2);
    assert.equal(before.basePathRefs, 1);
    assert.equal(before.publishMoves, 1);
    assert.equal(await fs.readFile(path.join(vault, "_AI.md"), "utf8"), "old guide");
    const after = run("--apply");
    assert.equal(after.verified, true);
    assert.equal(run("--verify").verified, true);
    const note = await fs.readFile(path.join(vault, "_Workspace", "40-Projects", "note.md"), "utf8");
    assert.match(note, /\[\[_Workspace\/80-Maps\/Home\|Home\]\]/);
    assert.match(note, /```md\n\[\[40-Projects\/note\]\]\n```/);
    const state = JSON.parse(await fs.readFile(path.join(data, "publish", "state.json"), "utf8"));
    assert.deepEqual(state.records.map(({ id, path: notePath }) => [id, notePath]), [["stable-id", "_Workspace/40-Projects/note.md"]]);
    assert.equal(await fs.readFile(path.join(vault, "_Workspace", "80-Maps", "Projects.base"), "utf8"), 'filters: file.inFolder("_Workspace/40-Projects")\n');
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
