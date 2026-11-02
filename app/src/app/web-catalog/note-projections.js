// Note projection writes for the Web Catalog store.
//
// Extracted from sqlite-store.js to keep that module cohesive: tags/aliases,
// flat scalar properties, the lossless typed frontmatter state and the canonical
// outbound-link targets. `notes_fts` is written here too because the FTS rowid is
// deleted/inserted atomically with the other projections.
export function createNoteProjections({ db }) {
  const deleteTags = db.prepare("DELETE FROM note_tags WHERE path = ?");
  const insertTag = db.prepare("INSERT OR IGNORE INTO note_tags (path, tag) VALUES (?, ?)");
  const deleteAliases = db.prepare("DELETE FROM note_aliases WHERE path = ?");
  const insertAlias = db.prepare("INSERT OR IGNORE INTO note_aliases (path, alias) VALUES (?, ?)");
  const deleteProperties = db.prepare("DELETE FROM note_properties WHERE path = ?");
  const insertProperty = db.prepare(
    "INSERT OR IGNORE INTO note_properties (path, key, value_text, value_type) VALUES (?, ?, ?, ?)",
  );
  const deleteFrontmatter = db.prepare("DELETE FROM note_frontmatter_state WHERE path = ?");
  const insertFrontmatter = db.prepare(
    "INSERT OR REPLACE INTO note_frontmatter_state (path, codec_version, encoded_value) VALUES (?, ?, ?)",
  );
  const deleteLinks = db.prepare("DELETE FROM note_links WHERE path = ?");
  const insertLink = db.prepare("INSERT OR IGNORE INTO note_links (path, target) VALUES (?, ?)");
  const deleteFts = db.prepare("DELETE FROM notes_fts WHERE path = ?");
  const deleteFtsByRowid = db.prepare("DELETE FROM notes_fts WHERE rowid = ?");
  const insertFts = db.prepare("INSERT INTO notes_fts (path, title, aliases, tags, raw) VALUES (?, ?, ?, ?, ?)");
  const selectLastRowid = db.prepare("SELECT last_insert_rowid() AS id");

  return {
    // Returns the new notes_fts rowid so the caller can persist nodes.fts_rowid.
    write(
      rel,
      {
        tags = [],
        aliases = [],
        properties = {},
        frontmatterState = null,
        links = [],
        title = "",
        raw = "",
        previousFtsRowid = null,
      } = {},
    ) {
      deleteTags.run(rel);
      for (const tag of tags) insertTag.run(rel, String(tag));
      deleteAliases.run(rel);
      for (const alias of aliases) insertAlias.run(rel, String(alias));
      deleteProperties.run(rel);
      for (const [key, value] of Object.entries(properties || {})) {
        insertProperty.run(rel, key, String(value), typeof value);
      }
      deleteFrontmatter.run(rel);
      if (frontmatterState) {
        insertFrontmatter.run(rel, frontmatterState.codecVersion, frontmatterState.encodedValue);
      }
      deleteLinks.run(rel);
      for (const target of links) insertLink.run(rel, String(target));
      // Delete the old FTS row by rowid (path is UNINDEXED, so WHERE path = ? would
      // full-scan the FTS table and make a 50k build O(N^2)).
      if (previousFtsRowid !== null && previousFtsRowid !== undefined) deleteFtsByRowid.run(previousFtsRowid);
      insertFts.run(rel, title, aliases.join(" "), tags.join(" "), raw ?? "");
      return selectLastRowid.get().id;
    },
    // Remove every note-only projection for one path (Base nodes have none of these).
    remove(rel, ftsRowid) {
      deleteTags.run(rel);
      deleteAliases.run(rel);
      deleteProperties.run(rel);
      deleteFrontmatter.run(rel);
      deleteLinks.run(rel);
      if (ftsRowid !== null && ftsRowid !== undefined) deleteFtsByRowid.run(ftsRowid);
      else deleteFts.run(rel);
    },
  };
}
