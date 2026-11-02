// #400 → migrated: the pending-author fact rendered by the Admin plane (issue #435 rulings §1-§3).
//
// **Migrated 2026-10-18 (lane w5-gates).** The defect this regression exists for is real and
// view-independent: the SSR renderer stringified the structured `{agent, model}` pending author
// into `作者 [object Object]`. The previous revision asserted the deleted Admin UI v2 detail card
// (`#vault-git details.card .data-table`, `[data-pending-count]`, `.facts`, `details.pending-paths`
// and the literal `作者 <agent> / <model>` fact string).
//
// What is asserted now (and why each half is still load-bearing):
//   * a real MCP write with an explicit `_meta[obsidian/author]` leaves a **non-empty pending
//     batch** — fail-closed: without a real Git repository this check FAILS, because a zero count
//     is not evidence about author rendering (ruling §3);
//   * the rendered Admin page contains `[object Object]` exactly zero times — the exact #400
//     defect, whatever element renders it;
//   * the prototype's own pending indicator (`“N 个待提交”`, `5-render.js` `gitState`) reports the
//     batch, so the page really is showing the state the write produced;
//   * **if** the page presents the author at all (a `作者` label or the agent name), then both the
//     agent and the model must be present — a half-rendered or stringified author still fails;
//   * the post-commit state is verified the same way (ruling §2): the committed path leaves the
//     pending report and `[object Object]` stays at zero.
// The literal `作者 <agent> / <model>` string and the v2 selectors are **retired** rather than
// re-anchored to a class the lane has not written yet: the prototype's pending row does not render
// the author, so demanding that exact fact would be inventing a contract. See
// the prototype markup.
import assert from 'node:assert/strict';

import { GATE_AUTHOR, mcpCall } from './admin-layout-fixture.mjs';

/** The note this regression writes; it owns the stimulus so the check is self-contained. */
export const AUTHOR_NOTE_PATH = 'notes/gate-author.md';
/** The Git author name `commitUnlocked` derives from the same pair. */
export const AUTHOR_GIT_NAME = `${GATE_AUTHOR.agent} (${GATE_AUTHOR.model})`;

const PROBE = `(() => {
  // textContent, not innerText: the pending fact lives inside a collapsed <details> in several
  // layouts, and "rendered but collapsed" still means the author was stringified into the DOM.
  const text = document.body.textContent || '';
  const pending = /(\\d+)\\s*个待提交|待提交\\s*[：:]?\\s*(\\d+)/.exec(text);
  return {
    objectObject: (text.match(/\\[object Object\\]/g) ?? []).length,
    pendingCount: pending ? Number(pending[1] ?? pending[2]) : null,
    hasAuthorLabel: text.includes('作者'),
    hasAgent: text.includes(${JSON.stringify(GATE_AUTHOR.agent)}),
    hasModel: text.includes(${JSON.stringify(GATE_AUTHOR.model)}),
    hasNotePath: text.includes(${JSON.stringify(AUTHOR_NOTE_PATH)}) || text.includes('gate-author.md'),
  };
})()`;

/**
 * Register the migrated #400 pending-author regression. `base` / `apiKey` drive the real MCP
 * surface, `gitRepo` / `gitReason` come from the fixture (fail-closed gate), and `goto` / `sleep`
 * / `tracePhase` are the scene's page helpers.
 */
export async function registerPendingAuthorCheck(ctx, { page, goto, sleep, tracePhase, base, apiKey, gitRepo, gitReason, vaultsUrl }) {
  await ctx.check('admin-layout #400（迁移）: 真实 MCP 写入的待提交状态可见，页面不出现 [object Object]', async () => {
    assert.equal(gitRepo, true, `#400 需要 fixture Vault 里有一个真实 Git 仓库（gitRepo=${gitRepo}, reason=${gitReason}）；空的待提交批次不能当作作者渲染的证据`);

    await mcpCall(base, apiKey, 'write_note', {
      path: AUTHOR_NOTE_PATH, overwrite: true,
      content: '# author gate\n\n#435/#400 pending author browser regression\n',
    });
    await goto(vaultsUrl);
    const first = await page.evaluate(PROBE);
    tracePhase('pending-author-write', { path: AUTHOR_NOTE_PATH, author: GATE_AUTHOR, sample: first });
    assert.ok(first.pendingCount !== null && first.pendingCount >= 1, `真实 MCP 写入必须留下非空待提交批次（页面上的“N 个待提交”读数为 ${first.pendingCount}）：${JSON.stringify(first)}`);
    assert.equal(first.objectObject, 0, '页面不得出现 [object Object]（结构化作者被字符串化正是 #400 的缺陷）');
    if (first.hasAuthorLabel || first.hasAgent) {
      assert.ok(first.hasAgent && first.hasModel, `页面渲染了作者就必须同时给出 agent 与 model：${JSON.stringify(first)}`);
    }

    // Sampling window (ruling §2): the fixture pins the debounce far beyond this scene, so the
    // batch must still be pending after a wait - the assertion above read a controlled state.
    await sleep(1500);
    await goto(vaultsUrl);
    const second = await page.evaluate(PROBE);
    tracePhase('pending-author-stable', { sample: second });
    assert.ok(second.pendingCount !== null && second.pendingCount >= 1, `待提交批次在采样窗口内消失（debounce 未被 fixture 固定）：${JSON.stringify(second)}`);
    assert.equal(second.objectObject, 0, '采样窗口后页面仍不得出现 [object Object]');

    // Post-commit state (ruling §2): a real MCP commit consumes the batch.
    const commit = await mcpCall(base, apiKey, 'git_commit', {
      message: 'chore(gate): #435 post-commit author state', paths: [AUTHOR_NOTE_PATH], includeAll: false, push: false,
    });
    const log = await mcpCall(base, apiKey, 'git_log', { limit: 5 });
    await goto(vaultsUrl);
    const after = await page.evaluate(PROBE);
    const committed = commit?.structuredContent ?? null;
    const head = log?.structuredContent?.commits?.[0] ?? null;
    tracePhase('pending-author-post-commit', { committed, head, sample: after });
    assert.equal(committed?.committed, true, `MCP git_commit 必须提交 ${AUTHOR_NOTE_PATH}：${JSON.stringify(committed ?? commit)}`);
    assert.ok(String(committed?.message ?? '').includes(`MCP-Agent: ${GATE_AUTHOR.agent}`), `提交信息必须带 MCP-Agent 尾注：${JSON.stringify(committed?.message)}`);
    assert.equal(head?.author, AUTHOR_GIT_NAME, `git_log 必须报告显式 Git 作者 "${AUTHOR_GIT_NAME}"，实际 ${JSON.stringify(head)}`);
    assert.equal(after.objectObject, 0, '提交后页面仍不得出现 [object Object]');
    if (after.hasNotePath) {
      assert.ok(after.pendingCount === null || after.pendingCount === 0, `已提交的路径不应再出现在待提交读数里：${JSON.stringify(after)}`);
    }
  });
}
