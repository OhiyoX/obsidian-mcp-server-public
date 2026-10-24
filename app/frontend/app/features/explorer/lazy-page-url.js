// Explorer tree page-request identity, extracted from `lazy-controller.js` so the controller keeps
// its request/lifecycle focus inside the architecture line budget.
//
// Path normalization and the children-API URL are the two things the controller, its ownership
// fences and the anchor walk all have to agree on, so they live together here: one normalizer, one
// URL builder, no request policy.
import { sortSpecQuery } from "./sort-spec.js";

export function normalizePath(value) {
  return String(value || "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

export const TREE_PAGE_LIMIT = 100;

// Existing children-API parameters only (`sort`/`direction`). The SortSpec is an
// explicit part of the request, never the default hidden behind the server.
export function treePageUrl({ parent = "", cursor = null, anchorPath = null, spec } = {}) {
  const query = new URLSearchParams({ parent });
  const { sort, direction } = sortSpecQuery(spec);
  query.set("sort", sort);
  query.set("direction", direction);
  if (cursor) query.set("cursor", cursor);
  if (anchorPath) query.set("anchorPath", anchorPath);
  return `/api/web/v2/tree?${query.toString()}`;
}
