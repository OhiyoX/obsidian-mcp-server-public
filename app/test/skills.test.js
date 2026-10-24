import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { zipSync } from "fflate";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-skills-"));
const vault = path.join(root, "vault");
await fs.mkdir(vault, { recursive: true });
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = path.join(root, "data");
process.env.GIT_ENABLED = "false";
process.env.SKILLS_PATH = "60-Skills";

const {
  exportSkillPackage,
  importSkillPackage,
  listSkillPackages,
  validateSkillPackage,
} = await import("../src/skills.js");
const { inspectZipFile } = await import("../src/file-transfer.js");
const { withRequestContext } = await import("../src/request-context.js");

const authored = (callback) => withRequestContext({ author: { agent: "test-agent", model: "test-model" } }, callback);
after(() => fs.rm(root, { recursive: true, force: true }));

async function createSkill(name = "deploy-app") {
  const skillRoot = path.join(vault, "60-Skills", "engineering", name);
  await fs.mkdir(path.join(skillRoot, "scripts"), { recursive: true });
  await fs.mkdir(path.join(skillRoot, "references"), { recursive: true });
  await fs.mkdir(path.join(skillRoot, "agents"), { recursive: true });
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), `---\nname: ${name}\ndescription: Deploy an application safely when the user requests a release.\npaths:\n  - "apps/**"\n---\n\n# Deploy\n\nRun scripts/validate.mjs before deployment.\n`);
  await fs.writeFile(path.join(skillRoot, "scripts", "validate.mjs"), "console.log('valid')\n");
  await fs.writeFile(path.join(skillRoot, "references", "runbook.md"), "# Runbook\n");
  await fs.writeFile(path.join(skillRoot, "checklist.pdf"), Buffer.from("example attachment"));
  await fs.writeFile(path.join(skillRoot, "agents", "openai.yaml"), "interface:\n  display_name: Deploy App\npolicy:\n  allow_implicit_invocation: false\n");
  return skillRoot;
}

test("discovers nested portable skill packages and inventories attached resources", async () => {
  await createSkill();
  const listed = await listSkillPackages();
  assert.equal(listed.skills.length, 1);
  const skill = listed.skills[0];
  assert.equal(skill.name, "deploy-app");
  assert.equal(skill.valid, true);
  assert.deepEqual(skill.paths, ["apps/**"]);
  assert.equal(skill.compatibility.codex, true);
  assert.equal(skill.compatibility.cursor, true);
  assert.equal(skill.compatibility.notionFiles, true);
  assert.ok(skill.resources.some((item) => item.path === "scripts/validate.mjs"));
  assert.ok(skill.resources.some((item) => item.path === "checklist.pdf"));
  assert.deepEqual(skill.warnings, []);
});

test("validation rejects folder/name mismatch", async () => {
  const mismatchRoot = path.join(vault, "60-Skills", "wrong-folder");
  await fs.mkdir(mismatchRoot, { recursive: true });
  await fs.writeFile(path.join(mismatchRoot, "SKILL.md"), "---\nname: right-name\ndescription: Valid description.\n---\nInstructions\n");
  const mismatch = await validateSkillPackage("wrong-folder");
  assert.equal(mismatch.valid, false);
  assert.match(mismatch.errors.join(" "), /match package directory/);
});

test("validation rejects symlink resources", async (t) => {
  const linkRoot = path.join(vault, "60-Skills", "linked-skill");
  await fs.mkdir(linkRoot, { recursive: true });
  await fs.writeFile(path.join(linkRoot, "SKILL.md"), "---\nname: linked-skill\ndescription: Skill containing an invalid symlink.\n---\nInstructions\n");
  try {
    await fs.symlink(path.join(linkRoot, "SKILL.md"), path.join(linkRoot, "reference-link.md"));
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return t.skip("symlinks are unavailable on this platform");
    throw error;
  }
  const linked = await validateSkillPackage("linked-skill");
  assert.equal(linked.valid, false);
  assert.match(linked.errors.join(" "), /symbolic links/);
});

test("discovery reports malformed SKILL.md frontmatter without aborting the catalog", async () => {
  const malformedRoot = path.join(vault, "60-Skills", "malformed-skill");
  await fs.mkdir(malformedRoot, { recursive: true });
  await fs.writeFile(path.join(malformedRoot, "SKILL.md"), "---\nname: [unterminated\n---\nInstructions\n");
  const listed = await listSkillPackages();
  const malformed = listed.skills.find((item) => item.path.endsWith("malformed-skill"));
  assert.equal(malformed.valid, false);
  assert.match(malformed.errors.join(" "), /frontmatter is invalid/);
});

test("exports and imports a self-contained portable Skill ZIP", async () => {
  const sourceRoot = path.join(vault, "60-Skills", "engineering", "deploy-app");
  if (!(await fs.stat(sourceRoot).then(() => true, () => false))) await createSkill();
  const exported = await authored(() => exportSkillPackage({ skill: "engineering/deploy-app" }));
  assert.equal(exported.skill, "deploy-app");
  const inspected = await inspectZipFile(exported.path);
  assert.ok(inspected.entries.some((item) => item.path === "deploy-app/SKILL.md"));
  assert.ok(inspected.entries.some((item) => item.path === "deploy-app/scripts/validate.mjs"));

  await fs.rm(sourceRoot, { recursive: true, force: true });
  const preview = await authored(() => importSkillPackage({ archivePath: exported.path, dryRun: true }));
  assert.equal(preview.destination, "60-Skills/deploy-app");
  assert.equal(await fs.stat(path.join(vault, preview.destination)).then(() => true, () => false), false);
  const imported = await authored(() => importSkillPackage({ archivePath: exported.path, dryRun: false }));
  assert.equal(imported.validation.valid, true);
  assert.equal(await fs.readFile(path.join(vault, "60-Skills", "deploy-app", "scripts", "validate.mjs"), "utf8"), "console.log('valid')\n");
  await assert.rejects(() => authored(() => importSkillPackage({ archivePath: exported.path, dryRun: false })), /already exists/);
});

test("Skill ZIP import rejects traversal and multiple package roots", async () => {
  const unsafePath = path.join(vault, "unsafe-skill.zip");
  await fs.writeFile(unsafePath, Buffer.from(zipSync({ "../escape/SKILL.md": new Uint8Array(Buffer.from("no")) })));
  await assert.rejects(() => authored(() => importSkillPackage({ archivePath: "unsafe-skill.zip" })), /traversal|Unsafe/);

  const multiplePath = path.join(vault, "multiple-skills.zip");
  const skill = (name) => new Uint8Array(Buffer.from(`---\nname: ${name}\ndescription: Example.\n---\nInstructions\n`));
  await fs.writeFile(multiplePath, Buffer.from(zipSync({ "one/SKILL.md": skill("one"), "two/SKILL.md": skill("two") })));
  await assert.rejects(() => authored(() => importSkillPackage({ archivePath: "multiple-skills.zip" })), /exactly one package root/);
});
