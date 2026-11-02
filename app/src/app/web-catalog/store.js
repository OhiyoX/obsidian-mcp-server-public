// Web Catalog store facade. Phase 1A ships the SQLite implementation only; the
// facade exists so later Storage Runtime work can swap the backing store without
// rewriting callers.
export { openWebCatalogStore } from "./sqlite-store.js";
export {
  WEB_CATALOG_SCHEMA_VERSION,
  WEB_CATALOG_INDEXES,
  REQUIRED_META_KEYS,
  migrateWebCatalog,
} from "./schema.js";
export {
  WEB_CATALOG_CURSOR_VERSION,
  WebCatalogCursorError,
  WebCatalogAnchorError,
  encodeWebCatalogCursor,
  decodeWebCatalogCursor,
} from "./cursor.js";
export { WebCatalogPathError, assertCatalogPath } from "./catalog-path.js";
export { ORDERINGS, SORT_CONTRACT_VERSION, currentSortContract, sortContractId } from "./ordering.js";
export { catalogRecordFromRead, baseRecordFromRead, fileRecordFromEntry, extractLinkTargets, ensureCatalogDirectories, upsertCatalogRead, upsertCatalogBase, upsertCatalogFile, createVaultCatalogSource } from "./indexer.js";
export { createWebCatalogReconciler } from "./reconcile.js";
export {
  NOTE_KIND,
  BASE_KIND,
  FILE_KIND,
  documentKindForName,
  catalogKindForName,
  isCatalogDocumentPath,
  isCatalogInventoryPath,
  listMarkdownUnder,
  listCatalogDocumentsUnder,
  listCatalogInventoryUnder,
  toRootRelative,
} from "./vault-source.js";
export { readBaseInRoot, readNoteInRoot } from "./note-reader.js";
export {
  FRONTMATTER_CODEC_VERSION,
  WebCatalogValueCodecError,
  encodeFrontmatter,
  decodeFrontmatter,
} from "./value-codec.js";
export { SEMANTIC_CANDIDATE_LIMIT, SemanticUnavailableError, joinSemanticCandidates } from "./semantic-candidates.js";
export {
  SEARCH_CANDIDATE_MODES,
  SEARCH_RANK_MODES,
  SEARCH_SCORE_SCALE,
  SEARCH_CANDIDATE_DEFAULT_PAGE,
  SEARCH_CANDIDATE_MAX_PAGE,
  buildWebCatalogSearchQuery,
} from "./search-query.js";
export { MIN_TRIGRAM_LENGTH, ftsPhrase, planSearchCandidates, searchQueryHash } from "./search-planner.js";
export {
  WEB_CATALOG_SEARCH_CURSOR_VERSION,
  SEARCH_PAGE_DEFAULT,
  SEARCH_PAGE_MAX,
  MAX_CANDIDATES_PER_REQUEST,
  SECOND_PASS_BUDGET,
  WebCatalogSearchCursorError,
  encodeSearchCursor,
  decodeSearchCursor,
  searchCandidates,
} from "./search-candidates.js";
