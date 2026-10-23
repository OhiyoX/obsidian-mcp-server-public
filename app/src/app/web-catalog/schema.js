// Web Catalog schema — derived, rebuildable index of Vault metadata.
//
// Contract: _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Web 大型 Vault 动态加载与持久索引架构.md
// Tree ordering contract (frozen): docs/web-explorer-sort-model.md (#178).
//
// Markdown files remain the source of truth; every table here can be dropped and
// rebuilt from the Vault. Never store the only copy of any content here.
//
// A catalog is only trusted when its version, every owned table shape, every
// required index definition and its required metadata (catalogId / generation /
// stale / sort-contract) all match this module. Anything else — including a
// *missing* table or a same-named index with a different definition — rebuilds the
// whole derived catalog in one transaction instead of being "stamped" healthy.
import crypto from "node:crypto";
import { currentSortContract, sortContractId } from "./ordering.js";

export const WEB_CATALOG_SCHEMA_VERSION = 9;

// Ordering columns are precomputed in JS (the only place the pinned zh-Hans
// collator and the raw UTF-16 path order exist):
//   kind_rank        0 directory, 1 note|base|file -> folders always render first
//                    and every non-directory child shares one file group
//   name_rank        dense collator rank within (parent, kind), ties share a rank
//   name_rank_desc   -name_rank (folds `desc` into an ascending column)
//   modified_valid   1 when modified_ms is missing/invalid (always sorts last)
//   modified_asc     dir: name_rank; valid file: modified_ms; invalid: 0
//   modified_desc    dir: name_rank; valid file: -modified_ms; invalid: 0
//   path_key         hex of UTF-16BE code units -> SQLite BINARY order equals the
//                    frozen JS raw UTF-16 path tie-break (not SQLite UTF-8 BINARY).
// Schema v9 adds the `file` node kind (attachments: path/name/extension/size/mtime
// only — no content projections). v8 catalogs lack those nodes, so the version bump
// forces a rebuild instead of leaving an old catalog that looks healthy.
const TABLES = `
CREATE TABLE IF NOT EXISTS catalog_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  path TEXT PRIMARY KEY,
  path_key TEXT NOT NULL DEFAULT '',
  parent_path TEXT NOT NULL,
  name TEXT NOT NULL,
  basename TEXT NOT NULL,
  kind TEXT NOT NULL,
  kind_rank INTEGER NOT NULL DEFAULT 1,
  name_rank INTEGER NOT NULL DEFAULT 0,
  name_rank_desc INTEGER NOT NULL DEFAULT 0,
  modified_valid INTEGER NOT NULL DEFAULT 1,
  modified_asc INTEGER NOT NULL DEFAULT 0,
  modified_desc INTEGER NOT NULL DEFAULT 0,
  size INTEGER,
  modified_ms INTEGER,
  created_ms INTEGER,
  revision TEXT,
  metadata_revision TEXT,
  fts_rowid INTEGER,
  indexed_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS note_tags (
  path TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY(path, tag)
);

CREATE TABLE IF NOT EXISTS note_aliases (
  path TEXT NOT NULL,
  alias TEXT NOT NULL,
  PRIMARY KEY(path, alias)
);

CREATE TABLE IF NOT EXISTS note_properties (
  path TEXT NOT NULL,
  key TEXT NOT NULL,
  value_text TEXT,
  value_type TEXT NOT NULL,
  PRIMARY KEY(path, key, value_text)
);

-- Full frontmatter value tree (typed codec) and the canonical outbound-link
-- targets the Base record source needs. The flat note_properties table above
-- stays a scalar search projection; these two are the lossless Base projections.
CREATE TABLE IF NOT EXISTS note_frontmatter_state (
  path TEXT PRIMARY KEY,
  codec_version INTEGER NOT NULL,
  encoded_value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS note_links (
  path TEXT NOT NULL,
  target TEXT NOT NULL,
  PRIMARY KEY(path, target)
);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  path,
  title,
  aliases,
  tags,
  raw,
  tokenize='trigram'
);
`;

// The canonical index manifest. `WEB_CATALOG_SCHEMA` is generated from it and
// migration verifies the live definitions against it, so a same-named index with
// a different definition can never be silently kept by CREATE ... IF NOT EXISTS.
export const WEB_CATALOG_INDEXES = [
  {
    name: "nodes_parent_name_asc",
    sql: "CREATE INDEX IF NOT EXISTS nodes_parent_name_asc ON nodes(parent_path, kind_rank, name_rank, path_key)",
  },
  {
    name: "nodes_parent_name_desc",
    sql: "CREATE INDEX IF NOT EXISTS nodes_parent_name_desc ON nodes(parent_path, kind_rank, name_rank_desc, path_key)",
  },
  {
    name: "nodes_parent_modified_asc",
    sql: "CREATE INDEX IF NOT EXISTS nodes_parent_modified_asc ON nodes(parent_path, kind_rank, modified_valid, modified_asc, name_rank, path_key)",
  },
  {
    name: "nodes_parent_modified_desc",
    sql: "CREATE INDEX IF NOT EXISTS nodes_parent_modified_desc ON nodes(parent_path, kind_rank, modified_valid, modified_desc, name_rank, path_key)",
  },
  {
    name: "note_tags_tag_path",
    sql: "CREATE INDEX IF NOT EXISTS note_tags_tag_path ON note_tags(tag, path)",
  },
  {
    name: "note_properties_key_value",
    sql: "CREATE INDEX IF NOT EXISTS note_properties_key_value ON note_properties(key, value_text, path)",
  },
  {
    // file.hasLink resolves candidate notes by link target (reverse lookup).
    name: "note_links_target_path",
    sql: "CREATE INDEX IF NOT EXISTS note_links_target_path ON note_links(target, path)",
  },
  {
    // Residual (no bounded seed) search pages stream `nodes` in the frozen
    // path_key order; this index makes that a keyset range scan, never a sort.
    name: "nodes_kind_path_key",
    sql: "CREATE INDEX IF NOT EXISTS nodes_kind_path_key ON nodes(kind, path_key)",
  },
];

export const WEB_CATALOG_SCHEMA = `${TABLES}\n${WEB_CATALOG_INDEXES.map((index) => `${index.sql};`).join("\n")}\n`;

const EXPECTED_TABLE_COLUMNS = {
  catalog_meta: ["key", "value"],
  nodes: [
    "path",
    "path_key",
    "parent_path",
    "name",
    "basename",
    "kind",
    "kind_rank",
    "name_rank",
    "name_rank_desc",
    "modified_valid",
    "modified_asc",
    "modified_desc",
    "size",
    "modified_ms",
    "created_ms",
    "revision",
    "metadata_revision",
    "fts_rowid",
    "indexed_at_ms",
  ],
  note_tags: ["path", "tag"],
  note_aliases: ["path", "alias"],
  note_properties: ["path", "key", "value_text", "value_type"],
  note_frontmatter_state: ["path", "codec_version", "encoded_value"],
  note_links: ["path", "target"],
  notes_fts: ["path", "title", "aliases", "tags", "raw"],
};

export const REQUIRED_META_KEYS = [
  "schemaVersion",
  "catalogId",
  "catalogGeneration",
  "stale",
  "lastReconciledAt",
  "sortContract",
];

const CATALOG_TABLES = [
  "notes_fts",
  "note_links",
  "note_frontmatter_state",
  "note_properties",
  "note_aliases",
  "note_tags",
  "nodes",
  "catalog_meta",
];

function tableExists(db, name) {
  return (
    db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
  );
}

function tableSql(db, name) {
  return String(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)?.sql ?? "");
}

function indexSql(db, name) {
  return String(
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(name)?.sql ?? "",
  );
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name));
}

function normalizeSql(sql) {
  return String(sql)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/;$/, "")
    // SQLite stores the index SQL without the `IF NOT EXISTS` clause.
    .replace(/if not exists\s+/i, "")
    .toLowerCase();
}

// Every owned table must exist with the expected columns (a *missing* table is a
// mismatch, not a "create it empty and keep nodes" case).
function ownedTablesComplete(db) {
  for (const [table, columns] of Object.entries(EXPECTED_TABLE_COLUMNS)) {
    if (!tableExists(db, table)) return false;
    const actual = columnNames(db, table);
    if (!columns.every((column) => actual.includes(column))) return false;
  }
  // FTS5 with the frozen trigram tokenizer: substring semantics are a schema
  // contract, so a same-shaped table with another tokenizer is a mismatch.
  const ftsSql = tableSql(db, "notes_fts");
  return /using\s+fts5/i.test(ftsSql) && /trigram/i.test(ftsSql);
}

function classifyIndexes(db) {
  const missing = [];
  const wrong = [];
  for (const index of WEB_CATALOG_INDEXES) {
    const actual = indexSql(db, index.name);
    if (!actual) missing.push(index.name);
    else if (normalizeSql(actual) !== normalizeSql(index.sql)) wrong.push(index.name);
  }
  return { missing, wrong };
}

function inspectMeta(db, expectedSortContractId) {
  if (!tableExists(db, "catalog_meta")) return { ok: false };
  const meta = new Map(
    db.prepare("SELECT key, value FROM catalog_meta").all().map((row) => [String(row.key), String(row.value)]),
  );
  if (!REQUIRED_META_KEYS.every((key) => meta.has(key))) return { ok: false };
  if (meta.get("schemaVersion") !== String(WEB_CATALOG_SCHEMA_VERSION)) return { ok: false };
  const catalogId = meta.get("catalogId");
  if (!catalogId || catalogId.length > 128 || /[\r\n\u0000]/.test(catalogId)) return { ok: false };
  const generation = meta.get("catalogGeneration");
  if (!/^\d+$/.test(generation) || !Number.isSafeInteger(Number(generation))) return { ok: false };
  if (meta.get("stale") !== "0" && meta.get("stale") !== "1") return { ok: false };
  // A persisted rank is only trustworthy while the sort contract identity matches.
  if (meta.get("sortContract") !== expectedSortContractId) return { ok: false };
  return { ok: true, meta };
}

function dropDerivedCatalog(db) {
  for (const table of CATALOG_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
}

// Idempotent. Creates an empty catalog when absent; rebuilds the whole derived
// catalog when any part is missing, stale-versioned, the wrong shape, has a wrong
// index definition or invalid metadata. Missing-but-correct indexes are simply
// (re)created. Never touches Vault content.
// Returns { created, rebuilt, catalogId, version }.
export function migrateWebCatalog(db, { sortContract = currentSortContract() } = {}) {
  const expectedSortContractId = sortContractId(sortContract);
  const hadCatalog = CATALOG_TABLES.some((table) => tableExists(db, table));
  const tablesComplete = ownedTablesComplete(db);
  const indexes = classifyIndexes(db);
  const meta = inspectMeta(db, expectedSortContractId);
  const rebuilt = hadCatalog && (!tablesComplete || indexes.wrong.length > 0 || !meta.ok);
  const fresh = !hadCatalog || rebuilt;

  db.exec("BEGIN IMMEDIATE");
  try {
    if (rebuilt) dropDerivedCatalog(db);
    db.exec(WEB_CATALOG_SCHEMA);
    const setMeta = db.prepare(
      "INSERT INTO catalog_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    setMeta.run("schemaVersion", String(WEB_CATALOG_SCHEMA_VERSION));
    if (fresh) {
      const insertMeta = db.prepare("INSERT OR IGNORE INTO catalog_meta (key, value) VALUES (?, ?)");
      setMeta.run("catalogId", crypto.randomUUID());
      insertMeta.run("catalogGeneration", "0");
      insertMeta.run("stale", "0");
      insertMeta.run("lastReconciledAt", "");
      setMeta.run("sortContract", expectedSortContractId);
    } else {
      // Healthy catalog: repair any missing index without touching its data.
      setMeta.run("sortContract", expectedSortContractId);
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The connection may already be unusable; surface the original error.
    }
    throw error;
  }

  const catalogId = String(db.prepare("SELECT value FROM catalog_meta WHERE key = 'catalogId'").get().value);
  return { created: !hadCatalog, rebuilt, catalogId, version: WEB_CATALOG_SCHEMA_VERSION };
}
