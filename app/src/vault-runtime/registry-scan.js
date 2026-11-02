// W2 (#437) — bounded directory enumeration for Vault discovery, contract §1 / §4.1.
//
// Authority: `_Workspace/40-Projects/obsidian_mcp_server/Architecture/DEVELOPMENT - Vault 热发现与准入（Issue 437）.md`
//   §1   每个允许父目录最多 4096 条；每轮 5s 逻辑期限；**必须有界枚举**（不得先无界 readdir 再检查）；
//        超时结果不得晚到进入发布；尚未结束的 I/O 仍计入单飞
//   §4.1 路径安全与有界枚举（发现只针对允许父目录的直接子目录）
//   §41  boundedness · §43-5 no global path/env import
//
// Extracted from `registry.js` (which must stay under the repository line budget) as a cohesive
// unit: "read at most N dirents of one directory, or give up loudly". It owns its stable error
// codes; `registry.js` re-exports them so consumers keep one import site.
//
// Deliberate properties:
//   * production (`fs.opendir`) **streams** entries: the cap is enforced while iterating, so a
//     hostile/storming parent is never materialized in full;
//   * the logical deadline is checked before every entry and once more after the loop, so a slow
//     filesystem aborts the round instead of publishing a late result;
//   * an injected test `fsApi` exposing only `readdir` is supported, but the cap and the deadline
//     are still enforced before any candidate work happens;
//   * the handle is always closed before returning/throwing — the directory I/O is part of the
//     caller's in-flight promise, which is what makes an unfinished enumeration count as
//     single-flight (contract §1).

/** Per-parent entry ceiling (contract §1: 每个允许父目录最多 4096 个条目). */
export const MAX_ENTRIES_PER_PARENT = 4096;

/** Per-round logical deadline (contract §1: 每轮 5s 逻辑期限). */
export const ROUND_BUDGET_MS = 5000;

export const VAULT_REGISTRY_BOUND_EXCEEDED = "VAULT_REGISTRY_BOUND_EXCEEDED";
export const VAULT_REGISTRY_INVENTORY_UNREADABLE = "VAULT_REGISTRY_INVENTORY_UNREADABLE";
export const VAULT_REGISTRY_ROUND_TIMEOUT = "VAULT_REGISTRY_ROUND_TIMEOUT";

function fail(code, detail) {
  throw Object.assign(new Error(`[${code}] ${detail}`), { code });
}

/**
 * Read at most `maxEntriesPerParent` dirents of `directory`, aborting on the logical deadline.
 * Returns the dirents as the injected `fsApi` produced them (shape validation belongs to the
 * caller). Throws `VAULT_REGISTRY_BOUND_EXCEEDED` / `VAULT_REGISTRY_ROUND_TIMEOUT` /
 * `VAULT_REGISTRY_INVENTORY_UNREADABLE`; nothing is ever partially returned.
 */
export async function collectEntries({ fsApi, directory, maxEntriesPerParent = MAX_ENTRIES_PER_PARENT, deadlineAt = null, now = Date.now } = {}) {
  if (!Number.isInteger(maxEntriesPerParent) || maxEntriesPerParent < 1) {
    fail(VAULT_REGISTRY_BOUND_EXCEEDED, `maxEntriesPerParent must be a positive integer, got ${String(maxEntriesPerParent)}`);
  }
  const checkDeadline = (phase) => {
    if (deadlineAt !== null && now() > deadlineAt) {
      fail(
        VAULT_REGISTRY_ROUND_TIMEOUT,
        `directory discovery ${phase} ${JSON.stringify(directory)} exceeded the logical round deadline (${deadlineAt}): ` +
          "the round is abandoned and nothing is published (contract §1/§4.1)",
      );
    }
  };
  const overBound = (count) => {
    fail(
      VAULT_REGISTRY_BOUND_EXCEEDED,
      `${JSON.stringify(directory)} holds ${count} entries, above the ${maxEntriesPerParent} per-parent bound: refusing to enumerate further ` +
        "(bounded discovery, contract §1)",
    );
  };

  if (typeof fsApi.opendir === "function") {
    let handle;
    try {
      handle = await fsApi.opendir(directory);
    } catch (error) {
      fail(VAULT_REGISTRY_INVENTORY_UNREADABLE, `cannot list ${JSON.stringify(directory)}: ${error?.code || error?.message || "unknown error"}`);
    }
    const collected = [];
    try {
      for await (const entry of handle) {
        checkDeadline("while enumerating");
        if (collected.length >= maxEntriesPerParent) overBound(collected.length + 1);
        collected.push(entry);
      }
    } finally {
      await handle.close().catch(() => {});
    }
    checkDeadline("after enumerating");
    return collected;
  }

  let entries;
  try {
    entries = await fsApi.readdir(directory, { withFileTypes: true });
  } catch (error) {
    fail(VAULT_REGISTRY_INVENTORY_UNREADABLE, `cannot list ${JSON.stringify(directory)}: ${error?.code || error?.message || "unknown error"}`);
  }
  checkDeadline("after enumerating");
  if (Array.isArray(entries) && entries.length > maxEntriesPerParent) overBound(entries.length);
  return entries;
}
