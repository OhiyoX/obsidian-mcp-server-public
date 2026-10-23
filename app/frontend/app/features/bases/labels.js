// User-facing Base strings: the sentences the Base surface paints.
//
// Why they live here and not in view.js: the surface renderer is at its 500-line
// architecture cap, and these constants are read by exactly one module.
//
// The desktop never prints a request-layer diagnostic (it shows i18n text such as
// `Unable to parse your base file:`, asar i18n.js@115061 block `plugins.bases.msg-*`),
// and this surface must not either. The diagnostic identity travels beside the text:
// `BASE_STALE_CODE` becomes `data-catalog-stale-code` on the banner, and the
// controller keeps the server `code` / HTTP status on the error state.
export const BASE_EMPTY_TEXT = "此视图没有匹配的记录。";
export const BASE_BUSY_TEXT = "正在加载…";
export const BASE_STALE_CODE = "CATALOG_STALE";
export const BASE_STALE_TEXT = "索引快照已过期，下面显示的是上一次读到的最新数据。";
export const BASE_LOAD_MORE_TEXT = "加载更多";
export const BASE_RETRY_TEXT = "重试";
