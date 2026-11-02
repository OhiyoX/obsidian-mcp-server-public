// Index-only tag aggregation for the Web Catalog store.
//
// `note_tags` is grouped through its covering `note_tags_tag_path(tag, path)`
// index, so the answer never touches `nodes` or the Vault filesystem. Sort keys
// are a fixed whitelist (never interpolated user input) and `tag ASC` is the
// pinned tie-break for equal counts.
export function createTagQueries(db) {
  const TAG_SORT_CLAUSES = {
    count: { asc: "count ASC, tag ASC", desc: "count DESC, tag ASC" },
    name: { asc: "tag ASC", desc: "tag DESC" },
  };

  const tagsQuery = (options = {}) => {
    const clause = TAG_SORT_CLAUSES[options.sort]?.[options.direction] ?? TAG_SORT_CLAUSES.count.desc;
    return {
      sql: `SELECT tag, COUNT(*) AS count FROM note_tags GROUP BY tag ORDER BY ${clause} LIMIT ?`,
      params: [options.limit ?? 500],
    };
  };

  const listTags = (options = {}) => {
    const { sql, params } = tagsQuery(options);
    const tags = db.prepare(sql).all(...params).map((row) => ({ tag: row.tag, count: row.count }));
    const total = db.prepare("SELECT COUNT(DISTINCT tag) AS n FROM note_tags").get().n;
    return { tags, total };
  };

  // EXPLAIN QUERY PLAN for the exact tag aggregate — lets the scale gate assert the
  // grouping is served by the covering index instead of a table scan.
  const planListTags = (options = {}) => {
    const { sql, params } = tagsQuery(options);
    return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
  };

  return { listTags, planListTags };
}
