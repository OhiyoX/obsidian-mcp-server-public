// The Base property page's write face (`显示名称`), extracted from `controller.js` so the
// controller stays inside its 500-line architecture cap (surface contract WB-…).
//
// One operation, one endpoint: `PATCH /api/web/v1/base` with a `set-property-display-name`
// mutation and a CAS precondition (`WRITE-SURFACE-DESIGN.md` §4). Its two refusal faces are
// deliberately NOT one branch (#624):
//
//   * 428 `precondition-required` — the request carried no revision at all. Retrying the same
//     request cannot help; the surface has to say so, and the reader has to reload.
//   * 409 `revision-conflict` — the document moved under us; the body carries the server's
//     `currentRevision`, so the caller can adopt it and re-read before the reader commits again.
//
// `value: null` means "delete the key" (desktop `PropertyConfig.serialize()`, app.js@2352290,
// writes a displayName only when it is truthy) and the route accepts exactly that.
export const PROPERTY_WRITE_ENDPOINT = "/api/web/v1/base";

/** The single mutation this surface writes, in the route's own vocabulary. */
export function displayNameMutation(property, value) {
  return { op: "set-property-display-name", property, value };
}

function writeError(status, code, message, extra = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return Object.assign(error, extra);
}

/**
 * Map one refusal to the vocabulary the surface branches on (`428` / `409` stay distinct).
 *
 * The 409 sentence must describe what actually happened (review D1): the caller only claims the
 * revision was refreshed when the server really sent one, and says the opposite when it did not.
 * `recovered` is what the page's retry decision reads.
 */
export function propertyWriteError(status, payload, copy = null) {
  const code = typeof payload?.code === "string" ? payload.code : null;
  if (status === 428) {
    return writeError(428, code ?? "precondition-required", payload?.error || copy?.precondition || "请求缺少前条件（revision），本次未写入。");
  }
  if (status === 409) {
    const currentRevision = typeof payload?.currentRevision === "string" && payload.currentRevision ? payload.currentRevision : null;
    const message = currentRevision
      ? (copy?.staleAdopted || "Base 已在别处被修改，已取回最新 revision，请再次提交。")
      : (copy?.staleLost || "Base 已在别处被修改，且未取回最新 revision，请关闭后重新打开此页再试。");
    return writeError(409, code ?? "revision-conflict", message, { currentRevision, recovered: Boolean(currentRevision) });
  }
  const message = payload?.error || `保存失败（${status || "网络错误"}）`;
  return writeError(status, code, message);
}

/**
 * Patch one property's display name.
 * @returns {Promise<{revision?: string}>} the new document revision, when the server reports one.
 * @throws an Error carrying `status` / `code` (and `currentRevision` on a 409).
 */
export async function patchPropertyDisplayName({ fetchImpl, path, revision, property, value, copy = null } = {}) {
  if (typeof fetchImpl !== "function") throw writeError(0, "no-fetch", "当前环境没有可用的网络请求实现。");
  if (!property || !path) throw writeError(0, "invalid-request", "缺少属性名或 Base 路径。");
  // A write with no precondition would be answered 428 anyway; refuse it here so the reader gets
  // that message without a round trip, and never send a half-formed CAS.
  if (!revision) throw writeError(428, "precondition-required", "缺少 revision，无法写入；请重新载入 Base。");
  let response;
  try {
    response = await fetchImpl(PROPERTY_WRITE_ENDPOINT, {
      method: "PATCH",
      // Do NOT set the content type here: `api()` already does, and two case-variant keys
      // (`content-type` + `Content-Type`) are APPENDED by fetch, not overwritten — the wire value
      // becomes `application/json, application/json`, `express.json` no longer matches it, the
      // route sees no `path` and answers 400 `invalid-path`. Caught by the lane's Chromium probe;
      // the unit fake never looked at headers.
      headers: { accept: "application/json", "if-match": `"${revision}"` },
      body: JSON.stringify({ path, mutations: [displayNameMutation(property, value)], ifMatch: revision }),
    });
  } catch (cause) {
    throw writeError(0, "network", `保存失败：${cause?.message || "网络请求失败"}`);
  }
  let payload = null;
  try {
    payload = await response?.json?.();
  } catch {
    payload = null;
  }
  if (response?.ok === false) throw propertyWriteError(Number(response.status) || 0, payload, copy);
  return { revision: typeof payload?.revision === "string" ? payload.revision : undefined };
}

/**
 * The stateful half, kept here so the controller grows by two lines instead of a block:
 * a successful write adopts the returned revision and re-reads the document (a displayName
 * renames a table HEADER, not just this row); a 409 adopts the server's `currentRevision`,
 * re-reads too, and still rejects so the page can show the inline error and keep the text.
 */
export function createPropertyWriter({ fetchImpl, state, reload, copy = null } = {}) {
  return async function renameProperty({ property, value } = {}) {
    const attemptRevision = state?.revision;
    try {
      const result = await patchPropertyDisplayName({
        fetchImpl: typeof fetchImpl === "function" ? fetchImpl() : fetchImpl,
        path: state?.path,
        revision: attemptRevision,
        property,
        value,
        copy,
      });
      if (result?.revision) state.revision = result.revision;
      reload?.();
      return result;
    } catch (error) {
      // 409: adopt the server's revision, then rethrow (review D1). Deliberately NO reload here:
      // rebuilding the page would replace the field, so the reader would lose the text they typed and
      // the inline error would vanish — the opposite of what the page must show. The adopted revision
      // is what makes the NEXT submit a new write instead of the same stale one.
      if (error?.status === 409 && error.currentRevision) state.revision = error.currentRevision;
      error.attemptRevision = attemptRevision;
      error.nextRevision = state?.revision ?? null;
      throw error;
    }
  };
}
