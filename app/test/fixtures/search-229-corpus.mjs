// Issue #229 Wave A / A3 — synthetic acceptance corpus (test-only fixture).
//
// This module is pure data plus deterministic constructors. It contains no
// real user-Vault text: every note is written from the frozen issue contract
// (§9 Chinese body, §10 multi-term A/B/C) and from a synthetic Chinese +
// identifier mix for the 229 mode matrix. Do not add private paths, hostnames,
// credentials, or excerpts from a production Vault.
//
// Two consumers share it:
//   - app/test/search-229-characterization.test.js (module-level records and
//     the real registerSearchTools temp vault);
//   - the Wave B acceptance package in the task scratch directory (omitted
//     semantic, semanticMode/fallbackUsed/diagnostics matrix).
//
// The record projection must stay compatible with the Search v2 harness
// projection: path, name, basename, tags, aliases, frontmatter, raw, content,
// stat, revision.

import fs from "node:fs/promises";
import path from "node:path";

// Contract §9 frozen body. Kept exported so assertions cannot drift from the
// fixture bytes.
export const S229_CHINESE_BODY = "禁止自动合并 PR，必须先获得用户确认。";

// Deterministic, timezone-free stat used by every constructed record. The
// tool layer reads real fs.stat, so this value is only for module-level tests.
const FIXTURE_STAT = Object.freeze({
  size: 0,
  modified: "2026-10-04T00:00:00.000Z",
  created: "2026-10-04T00:00:00.000Z",
});

/**
 * Project a fixture note spec into the shape the search evaluator/hybrid tests
 * consume. `raw` stays byte-exact so tool tests can write it unchanged.
 */
export function makeRecord(note, index = 0) {
  const raw = note.raw ?? note.content ?? "";
  const content = note.content ?? note.raw ?? "";
  return {
    path: note.path,
    name: path.posix.basename(note.path),
    basename: path.posix.basename(note.path, ".md"),
    tags: note.tags ?? [],
    aliases: note.aliases ?? [],
    frontmatter: note.frontmatter ?? {},
    raw,
    content,
    stat: { ...FIXTURE_STAT, size: raw.length, ...(note.stat || {}) },
    revision: note.revision ?? `sha256:s229-fixture-${index}`,
  };
}

export function recordsFor(notes) {
  return notes.map((note, index) => makeRecord(note, index));
}

// §9 — Chinese behavior contract. One target note carries the frozen body and
// two distractors deliberately avoid 合并/授权/确认 so fallback targeting stays
// deterministic and independent of any embedding provider.
export function chineseFixture() {
  return [
    {
      path: "Notes/合并策略.md",
      tags: ["policy/merge"],
      aliases: [],
      frontmatter: { title: "合并策略", tags: ["policy/merge"] },
      raw: `---\ntitle: 合并策略\ntags:\n  - policy/merge\n---\n# 合并策略\n\n${S229_CHINESE_BODY}\n`,
      content: `# 合并策略\n\n${S229_CHINESE_BODY}\n`,
    },
    {
      path: "Notes/部署流程.md",
      tags: ["policy/deploy"],
      aliases: [],
      frontmatter: { title: "部署流程", tags: ["policy/deploy"] },
      raw: "---\ntitle: 部署流程\ntags:\n  - policy/deploy\n---\n# 部署流程\n\n自动部署只在维护窗口执行，步骤见运维手册。\n",
      content: "# 部署流程\n\n自动部署只在维护窗口执行，步骤见运维手册。\n",
    },
    {
      path: "Notes/会议记录.md",
      tags: [],
      aliases: [],
      frontmatter: { title: "会议记录" },
      raw: "---\ntitle: 会议记录\n---\n# 会议记录\n\n讨论了检索性能与索引刷新。\n",
      content: "# 会议记录\n\n讨论了检索性能与索引刷新。\n",
    },
  ];
}

// §10 — multi-term contract. A and C carry tag `x`; B carries `y`. The tags
// let the acceptance matrix prove fallback candidates still pass structural
// filters and cannot resurrect a tag that matches nothing.
export function multiTermFixture() {
  return [
    {
      path: "Notes/A.md",
      tags: ["x"],
      aliases: [],
      frontmatter: { title: "A", tags: ["x"] },
      raw: "---\ntitle: A\ntags:\n  - x\n---\n# A\n\nalpha only\n",
      content: "# A\n\nalpha only\n",
    },
    {
      path: "Notes/B.md",
      tags: ["y"],
      aliases: [],
      frontmatter: { title: "B", tags: ["y"] },
      raw: "---\ntitle: B\ntags:\n  - y\n---\n# B\n\nbeta only\n",
      content: "# B\n\nbeta only\n",
    },
    {
      path: "Notes/C.md",
      tags: ["x"],
      aliases: [],
      frontmatter: { title: "C", status: "active", tags: ["x"] },
      raw: "---\ntitle: C\nstatus: active\ntags:\n  - x\n---\n# C\n\nalpha beta\n",
      content: "# C\n\nalpha beta\n",
    },
  ];
}

// Issue-style Chinese + identifier mix for the §15.2 mode matrix. Synthetic
// only; identifiers here are public project vocabulary, not private data.
export function mixedFixture() {
  return [
    {
      path: "Ops/热路由缓存.md",
      tags: ["project/obsidian-mcp-server"],
      aliases: [],
      frontmatter: { title: "热路由缓存", status: "active", tags: ["project/obsidian-mcp-server"] },
      raw: "---\ntitle: 热路由缓存\nstatus: active\ntags:\n  - project/obsidian-mcp-server\n---\n# 热路由缓存\n\n热路由缓存 planRestoreVersion 已在 v1.2.3 发布。\n\n参考 app/src/search.js 的实现。\n",
      content: "# 热路由缓存\n\n热路由缓存 planRestoreVersion 已在 v1.2.3 发布。\n\n参考 app/src/search.js 的实现。\n",
    },
    {
      path: "Ops/版本回滚.md",
      tags: ["project/obsidian-mcp-server"],
      aliases: [],
      frontmatter: { title: "版本回滚", tags: ["project/obsidian-mcp-server"] },
      raw: "---\ntitle: 版本回滚\ntags:\n  - project/obsidian-mcp-server\n---\n# 版本回滚\n\nrestore_from_trash 与 dfba2c1 修复了回滚流程。\n",
      content: "# 版本回滚\n\nrestore_from_trash 与 dfba2c1 修复了回滚流程。\n",
    },
  ];
}

export function allFixtureNotes() {
  return [...chineseFixture(), ...multiTermFixture(), ...mixedFixture()];
}

/** Write `notes` (fixture specs) under `vault` as the exact `raw` bytes. */
export async function writeFixtureVault(vault, notes) {
  await fs.mkdir(vault, { recursive: true });
  for (const note of notes) {
    const absolute = path.join(vault, ...note.path.split("/"));
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    const raw = note.raw ?? note.content ?? "";
    await fs.writeFile(absolute, raw, "utf8");
  }
}
