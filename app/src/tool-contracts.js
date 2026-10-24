import { z } from "zod/v4";

// Top-level result contracts advertised to MCP clients. Complex nested values
// remain open so Obsidian/SDK additions stay backward compatible, while stable
// field names and scalar types give models a useful follow-up contract.
const contracts = {
  agent_bootstrap: ["policyVersion policySource policyUri client scope instructions writes workflow entrypoints routing boundaries nextRead compatibility", "writeAuthor"],
  server_info: ["ok tools index onboarding version", "vaultPath dataPath trashPath historyPath versionHistoryEnabled maxVersionsPerFile readOnly maxReadBytes"],
  get_note: ["path", "frontmatterFields headings blocks tags outgoingLinks frontmatter content cache stat revision section value block heading"],
  pull_note_file: ["path encoding content", "suggestedFilename mimeType byteLength sha256 revision complete stat"],
  get_metadata: ["path cache revision"],
  list_notes: ["directory entries truncated", "nextCursor"],
  list_files: ["directory acceptedExtensions entries truncated", "nextCursor"],
  list_recent: ["notes totalCount index"],
  search_notes: ["results totalScanned totalMatched truncated semanticRequested semanticMode fallbackUsed semanticUsed hybridUsed index", "semanticError diagnostics"],
  get_file: ["path extension encoding revision stat", "content range"],
  pull_file: ["path suggestedFilename mimeType encoding content byteLength sha256 revision complete stat"],
  write_file: ["path created previousSizeInBytes currentSizeInBytes revision removedHeadings removedBlocks shrinkRatio preWriteVersionId"],
  start_direct_upload: ["uploadId method relativePath expiresAt maxBytes sha256Required mode", "vaultId path totalBytes sha256 overwrite"],  start_file_upload: ["uploadId vaultPath totalBytes uploadedBytes overwrite acceptedOnly status createdAt expiresAt recommendedChunkBytes", "expectedSha256"],
  file_upload_status: ["uploadId path status uploadedBytes totalBytes nextOffset createdAt expiresAt completedAt result"],
  upload_file_chunk: ["uploadId complete", "path uploadedBytes totalBytes nextOffset size sha256 revision idempotentReplay"],
  cancel_file_upload: ["uploadId cancelled", "complete result"],
  create_archive: ["path format entries entryCount fileCount compressedBytes uncompressedBytes sha256 revision"],
  inspect_archive: ["path format entries entryCount fileCount compressedBytes uncompressedBytes sha256 revision"],
  read_archive_entry: ["archivePath entry path size compressedSize encoding truncated returnedBytes sha256 crc32 archiveSha256 archiveRevision", "content"],
  extract_archive: ["archivePath destinationDirectory dryRun collisions outputs", "entryCount fileCount compressedBytes uncompressedBytes extracted format entries"],
  get_canvas: ["path canvas revision summary"],
  write_canvas: ["path created previousSizeInBytes currentSizeInBytes revision"],
  write_note: ["path created previousSizeInBytes currentSizeInBytes revision removedHeadings removedBlocks shrinkRatio preWriteVersionId"],
  append_to_note: ["path created previousSizeInBytes currentSizeInBytes revision preWriteVersionId"],
  patch_note: ["path operation targetType target previousSizeInBytes currentSizeInBytes revision removedHeadings removedBlocks shrinkRatio preWriteVersionId"],
  replace_in_note: ["path replacements previousSizeInBytes currentSizeInBytes revision removedHeadings removedBlocks shrinkRatio preWriteVersionId"],
  manage_frontmatter: ["path frontmatter revision"],
  list_tags: ["tags index", "notes"],
  manage_tags: ["path frontmatter inline all revision"],
  move_note: ["moved updatedLinksIn"],
  delete_note: ["deleted previousSizeInBytes backup"],
  list_trash: ["entries truncated"],
  restore_from_trash: ["restoredPath backupPath backupRemoved revision size"],
  delete_trash_entry: ["deletedBackup"],
  list_versions: ["path versions"],
  restore_version: ["restoredPath versionId revision size"],
  delete_version: ["deletedVersion"],
  manage_folders: ["", "folder entries created deleted recursive"],
  get_backlinks: ["target backlinks"],
  get_graph: ["nodes edges truncated index"],
  get_unresolved_links: ["links truncated index"],
  get_orphans: ["notes truncated index"],
  get_deadends: ["notes truncated index"],
  list_tasks: ["tasks truncated index"],
  update_task: ["path line previousStatus status revision", "changed dryRun"],
  daily_note: ["path date", "period action exists content frontmatter revision stat created size"],
  list_templates: ["folder templates", "truncated"],
  create_from_template: ["template path created revision size"],
  list_properties: ["properties configuredTypes index"],
  list_aliases: ["aliases truncated index"],
  rename_property: ["from to dryRun changed skipped truncated"],
  set_property_type: ["name removed revision", "type"],
  list_bases: ["bases truncated"],
  get_base: ["path raw base valid errors", "revision"],
  write_base: ["path created revision size"],
  patch_base: ["path changed revision previousRevision size", "warnings"],
  create_base_entry: ["path basePath view folderSource created size revision", "frontmatter warnings"],
  query_base: ["path rows totalMatched truncated supportedSubset index", "view groups summaries"],
  list_base_views: ["path views", "defaultView"],
  git_status: ["branch clean changes pendingAutoCommitPaths configuration"],
  git_diff: ["staged path diff truncated"],
  git_log: ["commits"],
  git_commit: ["committed paths", "hash message author push reason commits"],
  git_pull: ["pulled remote branch output head"],
  git_push: ["pushed remote branch output head"],
  index_status: ["path version updatedAt notes chunks embeddedChunks embeddingModel semantic indexJob", "remote"],
  reindex_vault: ["status startedAt", "finishedAt force embeddings result error queuedFollowUp"],
  recall: ["query results totalCandidates semanticUsed semanticError index"],
  find_related: ["path results semanticUsed semanticError"],
  get_note_context: ["status path resolvedPath revision items sources warnings truncated budget index policy"],
  graph_health: ["notes links counts orphans deadends truncated", "issues"],
  suggest_links: ["path suggestions semanticUsed semanticError"],
  memory_capture: ["path revision managedRoot"],
  memory_recall: ["query results totalCandidates semanticUsed semanticError index"],
  skill_list: ["managedRoot skills truncated"],
  skill_match: ["query matches semanticUsed semanticError executionAuthorized"],
  skill_validate: ["valid errors warnings", "path title version trusted risk triggers"],
  skill_export: ["path skill schema format entries entryCount fileCount compressedBytes uncompressedBytes sha256 revision executionAuthorized"],
  skill_import: ["archivePath destination skill schema dryRun files warnings executionAuthorized", "imported validation revision"],
  get_publish_status: ["vaultId path privatePath privateUrl published", "publicPath publicUrl publishedAt"],
  manage_publish: ["vaultId path privatePath privateUrl published changed", "publicPath publicUrl publishedAt"],
  plan_note_changes: ["planId planHash createdAt expiresAt changed changes warnings"],
  plan_move_note: ["planId planHash createdAt expiresAt changed changes warnings"],
  plan_delete_note: ["planId planHash createdAt expiresAt changed changes warnings"],
  plan_restore_version: ["planId planHash createdAt expiresAt changed changes warnings"],
  plan_restore_from_trash: ["planId planHash createdAt expiresAt changed changes warnings"],
  get_note_plan: ["planId planHash createdAt expiresAt changed changes warnings"],
  apply_note_plan: ["planId planHash applied idempotentReplay changed unchanged appliedAt"],
  get_note_version: ["versionId path content size created modified revision truncated"],
  compare_note_versions: ["path left right changed beforeRevision afterRevision diff truncated summary"],
};

const arrayFields = new Set("tools workflow boundaries acceptedExtensions entries headings blocks tags outgoingLinks frontmatterFields notes results replacements inline all updatedLinksIn backlinks versions nodes edges links tasks templates properties aliases changed skipped bases rows changes pendingAutoCommitPaths commits collisions outputs suggestions skills matches errors warnings triggers paths files resources unchanged removedHeadings removedBlocks views".split(" "));
const booleanFields = new Set("ok versionHistoryEnabled readOnly truncated created complete overwrite acceptedOnly cancelled backupRemoved recursive valid supportedSubset committed pulled pushed force embeddings queuedFollowUp semanticRequested semanticUsed hybridUsed fallbackUsed executionAuthorized trusted dryRun exists changed removed idempotentReplay clean published sha256Required".split(" "));
const numberFields = new Set("maxVersionsPerFile maxReadBytes byteLength previousSizeInBytes currentSizeInBytes totalCount totalScanned totalMatched totalCandidates uploadedBytes totalBytes nextOffset size recommendedChunkBytes entryCount fileCount compressedBytes uncompressedBytes extracted imported notes chunks embeddedChunks links line shrinkRatio maxBytes".split(" "));
const objectFields = new Set("writes entrypoints routing nextRead compatibility index onboarding cache stat range canvas summary frontmatter moved configuration author push semantic indexJob counts orphans deadends base configuredTypes block writeAuthor validation".split(" "));
const nullableFields = new Set("backup completedAt expectedSha256 semanticError branch path updatedAt embeddingModel view type reason finishedAt publicPath publicUrl publishedAt preWriteVersionId defaultView".split(" "));

const perToolFields = {
  patch_base: { changed: z.boolean() },
  get_note: { heading: z.record(z.string(), z.unknown()) },
  // Issue #229 search_notes output contract: the semantic tri-state is a closed
  // enum and the zero-result diagnostics payload is a bounded, self-describing
  // object. Exact shapes here let the real MCP output schema validate the
  // payload the search tool actually returns (no string coercion fallback).
  search_notes: {
    semanticMode: z.enum(["auto", "off", "on"]),
    diagnostics: z.object({
      candidateRecords: z.number(),
      exactMatched: z.number(),
      groupCount: z.number(),
      implicitAnd: z.boolean(),
      truncated: z.boolean(),
      groups: z.array(z.object({
        groupIndex: z.number(),
        matchedRecords: z.number(),
        clauses: z.array(z.object({
          raw: z.string(),
          type: z.string(),
          negated: z.boolean(),
          matchedRecords: z.number(),
        }).passthrough()),
      }).passthrough()),
    }).passthrough(),
  },
  // Same field name, different scalar type than the global tables: version
  // timestamps are ISO strings while write_* `created` is a boolean, and
  // git_diff `staged` is the only boolean under that name. Without these
  // overrides the server rejects its own structuredContent with -32602.
  get_note_version: { created: z.string(), modified: z.string() },
  git_diff: { staged: z.boolean() },
  // Issue #254 read_archive_entry output contract: the global tables would type
  // `path` as nullable, `entry` as an object, `compressedSize`/`returnedBytes`
  // as strings and leave `encoding` open, so every declared field is pinned
  // here to the frozen literal contract.
  read_archive_entry: {
    archivePath: z.string(),
    entry: z.string(),
    path: z.string(),
    compressedSize: z.number(),
    returnedBytes: z.number(),
    encoding: z.enum(["text", "binary"]),
    sha256: z.string(),
    crc32: z.string(),
    archiveSha256: z.string(),
    archiveRevision: z.string(),
  },
  get_note_context: {
    status: z.enum(["ok", "partial", "not_found"]),
    path: z.string(),
    resolvedPath: z.union([z.string(), z.null()]),
    revision: z.union([z.string(), z.null()]),
    items: z.array(z.record(z.string(), z.unknown())),
    sources: z.array(z.record(z.string(), z.unknown())),
    warnings: z.array(z.object({ code: z.string(), message: z.string() }).passthrough()),
    truncated: z.boolean(),
    budget: z.object({
      maxChars: z.number(),
      usedChars: z.number(),
      maxItems: z.number(),
      usedItems: z.number(),
      counting: z.string(),
    }).passthrough(),
    index: z.union([z.record(z.string(), z.unknown()), z.null()]),
    policy: z.object({ source: z.string(), version: z.string() }).passthrough(),
  },
  file_upload_status: { result: z.union([z.record(z.string(), z.unknown()), z.null()]) },
  cancel_file_upload: { result: z.record(z.string(), z.unknown()) },
  reindex_vault: { result: z.record(z.string(), z.unknown()) },
  index_status: {
    version: z.number(),
    notes: z.number(),
    chunks: z.number(),
    embeddedChunks: z.number(),
    indexJob: z.union([z.record(z.string(), z.unknown()), z.null()]),
    remote: z.record(z.string(), z.unknown()),
  },
  graph_health: {
    notes: z.number(),
    links: z.number(),
    issues: z.array(z.object({
      source: z.string(),
      raw: z.string(),
      status: z.enum(["ambiguous", "unresolved"]),
      candidates: z.array(z.unknown()),
    }).passthrough()),
  },
  // Issue #627: the ADD-only grouping projection. `groups` / `summaries` are
  // OPTIONAL (declared-view only, absent otherwise), and their shapes are pinned
  // to the cut-4 DTO (`base-query.js` buildGroupingDto): a group is
  // { key, keyType, count, rowPaths } plus a per-group `summaries` when declared;
  // the grouping `summaries` value is { scope, values } where each value is
  // { summary, value, reason }. `.passthrough()` keeps future additive keys legal
  // while still typing the frozen ones instead of falling back to a string.
  query_base: {
    groups: z.array(z.object({
      key: z.unknown(),
      keyType: z.enum(["null", "boolean", "number", "string", "date", "datetime", "link"]),
      count: z.number(),
      rowPaths: z.array(z.string()),
    }).passthrough()).optional(),
    summaries: z.object({
      scope: z.string(),
      values: z.record(z.string(), z.unknown()),
    }).passthrough().optional(),
  },
  manage_folders: { created: z.string(), deleted: z.string() },
  manage_tags: { frontmatter: z.array(z.string()) },
  update_task: { changed: z.boolean() },
  manage_publish: { changed: z.boolean() },
  plan_note_changes: { changed: z.boolean() },
  plan_move_note: { changed: z.boolean() },
  plan_delete_note: { changed: z.boolean() },
  plan_restore_version: { changed: z.boolean() },
  plan_restore_from_trash: { changed: z.boolean() },
  get_note_plan: { changed: z.boolean() },
  apply_note_plan: { applied: z.boolean(), changed: z.array(z.unknown()) },
  compare_note_versions: { changed: z.boolean(), left: z.record(z.string(), z.unknown()), right: z.record(z.string(), z.unknown()) },
};

function fieldSchema(toolName, name) {
  if (perToolFields[toolName]?.[name]) return perToolFields[toolName][name].describe(`${name} value returned by the tool.`);
  if (arrayFields.has(name)) return z.array(z.unknown()).describe(`${name} values returned by the tool.`);
  if (booleanFields.has(name)) return z.boolean().describe(`${name} flag returned by the tool.`);
  if (numberFields.has(name)) return z.number().describe(`${name} count or byte value returned by the tool.`);
  if (objectFields.has(name)) return z.record(z.string(), z.unknown()).describe(`${name} object returned by the tool.`);
  if (name === "result") return z.record(z.string(), z.unknown()).describe(`${name} object returned by the tool.`);
  if (nullableFields.has(name)) return z.union([z.string(), z.null()]).describe(`${name} value returned by the tool.`);
  if (name === "content" || name === "value") return z.unknown().describe(`${name} returned by the tool.`);
  return z.string().describe(`${name} value returned by the tool.`);
}

function words(value) {
  return String(value || "").trim().split(/\s+/).filter(Boolean);
}

export function outputSchemaForTool(name) {
  const contract = contracts[name];
  if (!contract) return z.object({}).passthrough();
  const [requiredText, optionalText = ""] = contract;
  const shape = {};
  for (const key of words(requiredText)) shape[key] = fieldSchema(name, key);
  for (const key of words(optionalText)) shape[key] = fieldSchema(name, key).optional();
  return z.object(shape).passthrough();
}

export function completeToolAnnotations(annotations = {}) {
  const readOnlyHint = annotations.readOnlyHint === true;
  return {
    ...annotations,
    readOnlyHint,
    destructiveHint: readOnlyHint ? false : annotations.destructiveHint !== false,
    idempotentHint: readOnlyHint || annotations.idempotentHint === true,
    openWorldHint: annotations.openWorldHint === true,
  };
}

export function completeToolDescriptor(name, config) {
  const label = String(config.title || name).trim();
  return {
    ...config,
    outputSchema: config.outputSchema || outputSchemaForTool(name),
    annotations: completeToolAnnotations(config.annotations),
    _meta: {
      ...config._meta,
      "openai/toolInvocation/invoking": `${label}…`.slice(0, 64),
      "openai/toolInvocation/invoked": `${label} complete`.slice(0, 64),
    },
  };
}

export function hasDeclaredToolContract(name) {
  return Object.hasOwn(contracts, name);
}
