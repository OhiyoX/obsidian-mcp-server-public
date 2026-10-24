// Admin UI v2 W2: identity view-model for accounts / keys / clients / subjects.
// Pure. Never treats a display name as a row id. Full ids are identity ids, never secrets.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clean(value) {
  if (value == null) return "";
  return String(value).trim();
}

/** Shorten uuid-shaped local parts; leave short tokens verbatim. */
export function shortId(fullId, { keep = 8 } = {}) {
  const id = clean(fullId);
  if (!id) return "";
  const colon = id.indexOf(":");
  if (colon > 0) {
    const kind = id.slice(0, colon);
    const local = id.slice(colon + 1);
    if (UUID_RE.test(local)) return `${kind}:${local.slice(0, keep)}…`;
    return id;
  }
  if (UUID_RE.test(id)) return `${id.slice(0, keep)}…`;
  return id.length > 20 ? `${id.slice(0, keep)}…` : id;
}

/**
 * Build an identity view.
 * - missing/deleted: isMissing/isDeleted, display "已删除 / 未知"
 * - present but unnamed: isUnnamed, display "未命名"
 * - present with name: displayName from name
 * fullId stays the opaque id for POST fields.
 */
export function presentIdentity({
  id = "",
  name = "",
  kind = "",
  missing = false,
  deleted = false,
} = {}) {
  const fullId = clean(id);
  const display = clean(name);
  const isMissing = Boolean(missing) || (!fullId && !display);
  const isDeleted = Boolean(deleted) || isMissing;
  const isUnnamed = !isMissing && !isDeleted && !display;
  let displayName;
  if (isDeleted || isMissing) displayName = "已删除 / 未知";
  else if (isUnnamed) displayName = "未设置显示名";
  else displayName = display;
  return Object.freeze({
    displayName,
    kind: clean(kind),
    shortId: shortId(fullId),
    fullId,
    isMissing,
    isUnnamed,
    isDeleted,
  });
}

/** Stable row key: kind + full id; never displayName alone. */
export function identityRowKey(identity) {
  const kind = clean(identity?.kind);
  const id = clean(identity?.fullId);
  if (!id && !kind) return "";
  return kind ? `${kind}:${id}` : id;
}
