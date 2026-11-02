import assert from "node:assert/strict";
import test from "node:test";
import {
  computeBalancedTableColumns,
  computeTableOverflowGeometry,
  tableCellDisplayText,
  tableVisualUnits,
} from "../frontend/app/features/document/table-layout.js";

test("tables that fit the text column keep zero symmetric extension", () => {
  const geometry = computeTableOverflowGeometry(700, 700, 1400);
  assert.equal(geometry.extension, 0);
  assert.equal(geometry.overflow, false);
  assert.equal(geometry.visibleWidth, 700);
});

test("narrow overflow is split evenly around the article text axis", () => {
  const geometry = computeTableOverflowGeometry(900, 700, 1400);
  // 200px of overflow becomes 100px of overhang on each side; the table's
  // center stays locked to the text column center instead of drifting right.
  assert.equal(geometry.extension, 100);
  assert.equal(geometry.visibleWidth, 900);
  assert.equal(geometry.overflow, false);
  const columnCenter = 700 / 2;
  const tableLeft = -geometry.extension;
  const tableRight = tableLeft + 900;
  assert.equal((tableLeft + tableRight) / 2, columnCenter);
});

test("overflow wider than the pane is capped at the gutter and scrolls locally", () => {
  const geometry = computeTableOverflowGeometry(1300, 700, 900);
  // Only 100px of gutter exists per side, so the table cannot be centered
  // without spilling past the pane; the remainder stays in a local scroller.
  assert.equal(geometry.maxExtension, 100);
  assert.equal(geometry.extension, 100);
  assert.equal(geometry.visibleWidth, 900);
  assert.equal(geometry.overflow, true);
});

test("narrow viewports still grow into their (smaller) gutters symmetrically", () => {
  const geometry = computeTableOverflowGeometry(380, 334, 390);
  assert.equal(geometry.extension, 23);
  assert.equal(geometry.overflow, false);
  assert.equal(geometry.visibleWidth, 380);
});

test("narrow viewports cap at their gutter and keep a local scroller", () => {
  const geometry = computeTableOverflowGeometry(500, 334, 390);
  assert.equal(geometry.maxExtension, 28);
  assert.equal(geometry.extension, 28);
  assert.equal(geometry.visibleWidth, 390);
  assert.equal(geometry.overflow, true);
});

test("measured pane bounds cap the overhang by each real side gutter", () => {
  const geometry = computeTableOverflowGeometry(780, 700, 900, {
    paneLeft: 100, paneRight: 1000, columnLeft: 250, columnRight: 950, safety: 1,
  });
  // Left gutter is 150px but the text column is pushed right and only 50px of
  // right gutter exists, so the symmetric overhang caps at the smaller side.
  assert.equal(geometry.allowedLeft, 149);
  assert.equal(geometry.allowedRight, 49);
  assert.equal(geometry.maxExtension, 49);
  assert.equal(geometry.extension, 40);
  assert.equal(geometry.visibleWidth, 780);
  assert.equal(geometry.overflow, false);
});

test("measured pane bounds keep a wide table's left edge out from under the sidebar", () => {
  const geometry = computeTableOverflowGeometry(900, 700, 900, {
    paneLeft: 100, paneRight: 1000, columnLeft: 250, columnRight: 950, safety: 1,
  });
  assert.equal(geometry.extension, 49);
  assert.equal(geometry.visibleWidth, 798);
  assert.equal(geometry.overflow, true);
  // The capped overhang never reaches past the measured pane on the left; the
  // surplus stays in the caller's local horizontal scroller.
  assert.ok(250 - geometry.extension >= 100, JSON.stringify(geometry));
  assert.ok(950 + geometry.extension <= 1000, JSON.stringify(geometry));
});

test("visual units account for CJK density instead of treating every code point equally", () => {
  assert.equal(tableVisualUnits("状态"), 4);
  assert.ok(tableVisualUnits("Status") > 5);
  assert.ok(tableVisualUnits("中文说明") > tableVisualUnits("note"));
});

test("display-text normalization measures labels rather than Markdown chrome or URLs", () => {
  assert.equal(tableCellDisplayText("**done**"), "done");
  assert.equal(tableCellDisplayText("[Docs](https://example.com/very/long/path)"), "Docs");
  assert.equal(tableCellDisplayText("[[Target|Readable label]]"), "Readable label");
  assert.equal(tableCellDisplayText("`inline`"), "inline");
});

test("balanced columns keep compact fields dense and give prose more room", () => {
  const layout = computeBalancedTableColumns([
    ["ID", "Status", "Description"],
    ["1", "done", "Short summary"],
    ["2", "open", "This column contains a substantially longer readable description"],
    ["3", "pending", "中文说明需要更多横向空间以减少无意义换行"],
  ], { availableWidth: 700 });

  assert.equal(layout.widths.length, 3);
  assert.equal(layout.profiles[0].compact, true);
  assert.equal(layout.profiles[1].compact, true);
  assert.equal(layout.profiles[2].compact, false);
  assert.ok(layout.widths[2] > layout.widths[1], JSON.stringify(layout));
  assert.ok(layout.widths[1] <= 168, JSON.stringify(layout));
  assert.ok(Math.abs(layout.totalWidth - 700) <= 1, JSON.stringify(layout));
  assert.equal(layout.overflow, false);
});

test("available space is shared by demand while preserving readable minimums", () => {
  const layout = computeBalancedTableColumns([
    ["No.", "State", "Notes"],
    ["1", "done", "A long sentence with several words that benefits from wrapping later rather than sooner"],
    ["2", "open", "Another moderately long sentence for the descriptive column"],
  ], { availableWidth: 420 });

  assert.ok(layout.totalWidth <= 420.5, JSON.stringify(layout));
  assert.ok(layout.widths.every((width, index) => width >= layout.profiles[index].minWidth), JSON.stringify(layout));
  assert.ok(layout.widths[2] > layout.widths[0], JSON.stringify(layout));
  assert.equal(layout.overflow, false);
});


test("wrap-heavy responsibility tables consume spare width before leaving a large gutter", () => {
  const layout = computeBalancedTableColumns([
    ["路径", "职责"],
    ["scripts/*.user.js", "脚本实现与 @version 真源"],
    ["scripts/*.zip", "投放包；运维脚本解压后删除，只留 .user.js"],
    ["index.md", "人类说明、文件一览、更新记录"],
    ["index.html", "渲染器 + 嵌入块；不手改 embed JSON"],
    ["tools/sync-docs.mjs", "解压 zip、同步版本、更新记录、嵌入"],
    ["tools/ingest-zips.mjs", "zip 解压与脚本/README 识别"],
    ["tools/sync-share.mjs", "非覆盖 robocopy；目标更新跳过并提醒"],
  ], { availableWidth: 900 });

  assert.equal(layout.profiles[0].codeLike, true, JSON.stringify(layout));
  assert.equal(layout.profiles[0].compact, false, JSON.stringify(layout));
  assert.ok(layout.widths[0] >= 220, JSON.stringify(layout));
  assert.ok(layout.widths[1] >= 400, JSON.stringify(layout));
  assert.ok(layout.totalWidth >= 620, JSON.stringify(layout));
  assert.ok(Math.abs(layout.totalWidth - 900) <= 1, JSON.stringify(layout));
  assert.ok(layout.profiles[0].wrapDemand > 0, JSON.stringify(layout));
  assert.ok(layout.profiles[1].wrapDemand > 0, JSON.stringify(layout));
});

test("very narrow surfaces keep minimum readable widths and explicitly overflow", () => {
  const layout = computeBalancedTableColumns([
    ["Key", "Status", "Long explanation"],
    ["A", "done", "unbreakable_identifier_that_should_not_crush_the_column"],
    ["B", "open", "more text"],
  ], { availableWidth: 220 });

  assert.equal(layout.overflow, true);
  assert.ok(layout.totalWidth > 220, JSON.stringify(layout));
  assert.ok(layout.widths.every((width, index) => width >= layout.profiles[index].minWidth), JSON.stringify(layout));
});


test("short semantic headers stay on one line when the table budget can afford them", () => {
  const layout = computeBalancedTableColumns([
    ["路径", "归档后职责", "更新方式"],
    ["scripts/*.user.js", "真源", "自动同步"],
    ["tools/sync-docs.mjs", "版本与记录", "hook 更新"],
    ["index.html", "渲染器", "生成"],
  ], { availableWidth: 760 });

  assert.equal(layout.overflow, false, JSON.stringify(layout));
  layout.profiles.forEach((profile, index) => {
    assert.ok(
      layout.widths[index] + 0.5 >= Math.min(profile.headerNoWrapWidth, profile.idealWidth),
      JSON.stringify({ index, width: layout.widths[index], profile, layout }),
    );
  });
  assert.ok(layout.widths[1] >= 90, JSON.stringify(layout));
});

test("code-like columns reserve their longest token or explicitly wrap/overflow instead of spilling", () => {
  const layout = computeBalancedTableColumns([
    ["路径", "职责"],
    ["40-Projects/油猴脚本/", "Obsidian 项目记忆"],
    ["tools/ingest-zips.mjs", "zip 解压与脚本/README 识别"],
    ["tools/.docs-state.json", "上次已同步的脚本版本"],
  ], { availableWidth: 700 });

  assert.equal(layout.profiles[0].codeLike, true, JSON.stringify(layout));
  assert.ok(layout.profiles[0].nowrapContentWidth > 0, JSON.stringify(layout));
  assert.ok(
    layout.widths[0] + 0.5 >= Math.min(layout.profiles[0].nowrapContentWidth, 420),
    JSON.stringify(layout),
  );
});


test("Reader-sized text metrics reserve enough width for short CJK headers", () => {
  const layout = computeBalancedTableColumns([
    ["文件", "当前上限", "后续拆分目标"],
    ["frontend/app/core/app.js", "619", "继续抽取 document/vault workflow，最终只保留 bootstrap/wiring"],
    ["frontend/app/features/session/document-session.js", "511", "分离 save queue、conflict state 与 document identity，同时保留竞态门禁"],
    ["src/oauth-provider.js", "851", "分离 persistence、client、grant、token flow"],
    ["src/app/live-events.js", "600", "分离 transport lifecycle、replay、vault-event mapping"],
  ], {
    availableWidth: 640,
    // Reader inherits a normal 16px text face with 9px inline cell padding.
    unitPx: 8,
    cellChromePx: 20,
  });

  assert.equal(layout.overflow, false, JSON.stringify(layout));
  assert.ok(layout.widths[1] + 0.5 >= layout.profiles[1].headerNoWrapWidth, JSON.stringify(layout));
  assert.ok(layout.widths[1] >= 87, JSON.stringify(layout));
});

test("file-budget columns keep the compact numeric column narrow without wrapping its header", () => {
  const layout = computeBalancedTableColumns([
    ["文件", "当前上限", "后续拆分目标"],
    ["frontend/app/core/app.js", "619", "继续抽取 document/vault workflow，最终只保留 bootstrap/wiring"],
    ["frontend/app/features/session/document-session.js", "511", "分离 save queue、conflict state 与 document identity，同时保留竞态门禁"],
    ["src/oauth-provider.js", "851", "分离 persistence、client、grant、token flow"],
    ["src/app/live-events.js", "600", "分离 transport lifecycle、replay、vault-event mapping"],
  ], { availableWidth: 960 });

  assert.equal(layout.overflow, false, JSON.stringify(layout));
  assert.ok(Math.abs(layout.totalWidth - 960) <= 1, JSON.stringify(layout));
  assert.ok(layout.widths[1] + 0.5 >= layout.profiles[1].headerNoWrapWidth, JSON.stringify(layout));
  assert.ok(layout.widths[1] < layout.widths[0], JSON.stringify(layout));
  assert.ok(layout.widths[1] < layout.widths[2], JSON.stringify(layout));
  assert.ok(layout.widths[1] <= 150, JSON.stringify(layout));
  assert.ok(layout.widths[0] >= 320, JSON.stringify(layout));
});

test("dense status/prose tables overflow before splitting short status labels", () => {
  const layout = computeBalancedTableColumns([
    ["候选设计", "结论", "已有 primitive", "缺口"],
    ["get_note_context", "Not implemented", "get_note(document-map/full)、get_backlinks、find_related、recall", "缺 bounded、一次调用的上下文聚合服务与稳定 schema"],
    ["get_project_context", "Not implemented", "agent_bootstrap 可引导 search；frontmatter project 可检索", "缺项目 root/README/TODO/规则的明确发现算法与聚合 API"],
    ["get_workspace_instructions", "Not implemented", "agent_bootstrap 提供静态 server contract 和 conventions 路径", "缺动态读取、分层合并、信任标记与 bounded 输出"],
    ["move_note_safely", "核心语义已实现", "plan_move_note + apply_note_plan，旧 move_note 使用同一 planner", "进程内锁与 25 文件上限；尚无独立同名工具"],
  ], { availableWidth: 700 });

  assert.equal(layout.overflow, true, JSON.stringify(layout));
  assert.ok(layout.totalWidth > 700, JSON.stringify(layout));
  assert.ok(layout.profiles[1].shortPhraseNoWrapWidth >= 120, JSON.stringify(layout));
  assert.ok(
    layout.widths[1] + 0.5 >= layout.profiles[1].shortPhraseNoWrapWidth,
    JSON.stringify(layout),
  );
  assert.ok(layout.widths[2] >= 220, JSON.stringify(layout));
  assert.ok(layout.widths[3] >= 210, JSON.stringify(layout));
});

test("header length does not inflate the short-body phrase floor", () => {
  const layout = computeBalancedTableColumns([
    ["Table head HEADER-MARK", "Value"],
    ["CELL-MARK", "1"],
  ], { availableWidth: 660 });

  assert.equal(layout.overflow, false, JSON.stringify(layout));
  assert.ok(
    layout.profiles[0].shortPhraseNoWrapWidth < layout.profiles[0].headerNoWrapWidth,
    JSON.stringify(layout),
  );
});

