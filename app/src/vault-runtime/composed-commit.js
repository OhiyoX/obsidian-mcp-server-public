// One prevalidated registry/runtime/serving record; membership is copied at publication.
// Mutable lease lifecycle state remains internal and can still be revoked synchronously.
export const COMPOSED_COMMIT_INVALID = "VAULT_COMPOSED_COMMIT_INVALID";
const ownedInstances = new WeakMap();
// Public facts only. Raw runtime entries are delivered solely to the registered owner's closure.
export const instancesOf = record => record?.instances ?? null;
export function refuseComposed(detail) {
  throw Object.assign(new Error(`[${COMPOSED_COMMIT_INVALID}] ${detail}`), { code: COMPOSED_COMMIT_INVALID });
}
export function readonlyMapView(map) {
  if (map == null) return null;
  const copy = new Map(map);
  const view = Object.freeze({
    get: key => copy.get(key), has: key => copy.has(key), size: copy.size,
    keys: () => copy.keys(), values: () => copy.values(), entries: () => copy.entries(),
    forEach: (callback, thisArg) => copy.forEach((value, key) => callback.call(thisArg, value, key, view)),
    [Symbol.iterator]: () => copy[Symbol.iterator](),
  });
  return view;
}
export function readonlySetView(set) {
  if (set == null) return null;
  const copy = new Set(set);
  const view = Object.freeze({
    has: value => copy.has(value), size: copy.size,
    keys: () => copy.keys(), values: () => copy.values(), entries: () => copy.entries(),
    forEach: (callback, thisArg) => copy.forEach(value => callback.call(thisArg, value, value, view)),
    [Symbol.iterator]: () => copy[Symbol.iterator](),
  });
  return view;
}
function frozenCopy(value) {
  if (value === null || typeof value !== "object") return value;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    Array.isArray(item) ? Object.freeze(item.map(frozenCopy)) : frozenCopy(item)])));
}
function validate(snapshot, instances, serving, revision) {
  if (snapshot === null || typeof snapshot !== "object" || revision !== snapshot.revision) refuseComposed("snapshot/revision mismatch");
  if (instances === null) return; // truly standalone records only
  const descriptors = new Map(snapshot.vaults.map(descriptor => [descriptor.id, descriptor]));
  for (const [id, entry] of instances) {
    const descriptor = descriptors.get(id);
    if (!descriptor || !entry || !entry.descriptor || JSON.stringify(entry.descriptor) !== JSON.stringify(descriptor)) refuseComposed("runtime descriptor does not match snapshot");
    if (entry.runtime?.id !== id || entry.runtime?.root !== descriptor.root) refuseComposed("runtime identity/root mismatch");
    if (!descriptor.primary && entry.runtime.descriptor && JSON.stringify(entry.runtime.descriptor) !== JSON.stringify(descriptor)) refuseComposed("runtime descriptor facts mismatch");
  }
  for (const id of serving?.allowed ?? []) {
    if (!descriptors.has(id) || !instances.has(id) || snapshot.admissions?.[id]?.admitted === false) refuseComposed("allow-set contains an unprepared/refused id");
  }
}
export function composedRecord({ snapshot, instances = null, serving = null, revision = snapshot?.revision ?? null, commits = null }) {
  validate(snapshot, instances, serving, revision);
  const membership = instances === null ? null : new Map([...instances].map(([id, entry]) => [id, { ...entry }]));
  const publicEntries = membership === null ? null : new Map([...membership].map(([id, entry]) => [id,
    Object.freeze({ descriptor: entry.descriptor, generation: snapshot.admissions?.[id]?.generation ?? null, identityDigest: snapshot.admissions?.[id]?.identityDigest ?? null })]));
  const allowed = Object.freeze([...(serving?.allowed ?? [])]);
  const refusals = serving?.refusals instanceof Map || typeof serving?.refusals?.entries === "function"
    ? [...serving.refusals] : Object.entries(serving?.refusals ?? {});
  const record = Object.freeze({ revision, snapshot, commits, instances: readonlyMapView(publicEntries),
    serving: serving === null ? null : Object.freeze({ allowed, allowedSet: readonlySetView(new Set(allowed)),
      refusals: readonlyMapView(new Map(refusals.map(([id, refusal]) => [id, frozenCopy(refusal)]))) }) });
  ownedInstances.set(record, membership);
  return record;
}
export function servingOf(record) {
  return record?.serving == null ? null : Object.freeze({ allowed: record.serving.allowed, refusals: record.serving.refusals });
}
export function createComposedCommit() {
  let record = null;
  let owner = null;
  return Object.freeze({
    current: () => record,
    attachRuntimeMap(next) {
      if (owner !== null) refuseComposed("one runtime map owner only");
      owner = next;
    },
    runtimeOwner: () => owner === null ? null : Object.freeze({ refresh: owner.refresh }),
    publish(next) {
      if (!ownedInstances.has(next)) refuseComposed("publish requires a validated composed record");
      if (owner !== null && ownedInstances.get(next) === null) refuseComposed("attached runtime map is required");
      if (record !== null && next.revision < record.revision) refuseComposed("revision cannot move backwards");
      record = next;
      owner?.adopt?.(ownedInstances.get(next));
      return record;
    },
    clear() {
      if (owner !== null) refuseComposed("cannot clear an attached commit");
      record = null;
    },
  });
}
export function publishComposedRecord(composed, extra = {}, fallback = {}) {
  const prior = composed.current();
  const snapshot = extra.snapshot ?? prior?.snapshot ?? fallback.snapshot ?? null;
  if (extra.snapshot && extra.snapshot !== prior?.snapshot && (!extra.instances || extra.serving === undefined)) refuseComposed("new snapshot requires a complete staged runtime/serving payload");
  const instances = extra.instances ?? ownedInstances.get(prior) ?? null;
  if (instances === null) refuseComposed("a composed publication requires runtimes");
  const record = composed.publish(composedRecord({ snapshot, instances,
    serving: extra.serving !== undefined ? extra.serving : prior?.serving ?? null,
    revision: extra.revision ?? snapshot?.revision,
    commits: extra.commits !== undefined ? extra.commits : prior?.commits ?? fallback.commits ?? null }));
  fallback.adopt?.(record);
  return record;
}

export function servingWithout(record, id) {
  const serving = servingOf(record);
  return serving === null ? null : { allowed: serving.allowed.filter(value => value !== id), refusals: serving.refusals };
}
