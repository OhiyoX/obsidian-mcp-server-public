/**
 * Bounded TTL cache for last-seen revision per vault/path/type.
 * A→B→A within TTL must emit again (revert is a real change).
 */

export function createDedupCache({ ttlMs, maxSize }) {
  /** @type {Map<string, { revision: string, expiresAt: number }>} */
  const entries = new Map();

  function prune(now = Date.now()) {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }
    while (entries.size > maxSize) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
    }
  }

  function keyFor(event) {
    return [event.vaultId || "", event.path || "", event.type || ""].join("\0");
  }

  return {
    seen(event) {
      if (event.revision === undefined || event.revision === null || event.revision === "") return false;
      const key = keyFor(event);
      const now = Date.now();
      prune(now);
      const entry = entries.get(key);
      if (!entry) return false;
      if (entry.expiresAt <= now) {
        entries.delete(key);
        return false;
      }
      return entry.revision === String(event.revision);
    },
    remember(event) {
      if (event.type === "note.deleted" || (event.type === "asset.changed" && !event.revision)) {
        const prefix = [event.vaultId || "", event.path || "", ""].join("\0");
        for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key);
        return null;
      }
      if (event.revision === undefined || event.revision === null || event.revision === "") return null;
      const key = keyFor(event);
      const now = Date.now();
      prune(now);
      if (entries.has(key)) entries.delete(key);
      entries.set(key, { revision: String(event.revision), expiresAt: now + ttlMs });
      prune(now);
      return key;
    },
    clear() {
      entries.clear();
    },
    get size() {
      prune();
      return entries.size;
    },
  };
}
