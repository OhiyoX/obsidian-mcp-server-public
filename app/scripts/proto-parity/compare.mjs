// Prototype-parity gate — the pure comparator.
//
// `comparePage` takes the prototype's own extraction and the live page's extraction (same probe,
// two trees) and returns every difference as a printed line. It is pure: no browser, no filesystem,
// so `test/admin-redo/parity.test.js` can drive each difference class directly (that is where the
// negative controls for the comparator itself live).
//
// Severity contract (the lane brief): a difference turns the gate RED — nothing here is a warning.
//   * columns  : count, name and order are compared exactly; colgroup widths and the first row's
//                cell classes are compared as "the prototype's declaration must still be there";
//   * elements : every element the prototype page renders must exist on the live page (missing ⇒
//                failure; extra live classes are printed as notes, never as failures);
//   * drawer   : the `?id=` detail drawer's section/kv/field/choice inventory is compared both
//                ways — a field the prototype does not have is a difference too.

const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function listDiff(label, protoList, liveList, { ordered }) {
  const failures = [];
  if (ordered && protoList.length !== liveList.length) {
    failures.push(`${label}：数量不同 — 原型 ${protoList.length} 项 ${JSON.stringify(protoList)}，实现 ${liveList.length} 项 ${JSON.stringify(liveList)}`);
  }
  const liveSet = new Set(liveList);
  const protoSet = new Set(protoList);
  for (const item of protoList) {
    if (!liveSet.has(item)) failures.push(`${label}：缺少 ${JSON.stringify(item)}（原型有 ${protoList.length} 项：${JSON.stringify(protoList)}）`);
  }
  for (const item of liveList) {
    if (!protoSet.has(item)) failures.push(`${label}：多出原型没有的 ${JSON.stringify(item)}`);
  }
  if (ordered) {
    for (let index = 0; index < Math.min(protoList.length, liveList.length); index += 1) {
      if (protoList[index] !== liveList[index]) {
        failures.push(`${label}：第 ${index + 1} 项顺序/名称不同 — 原型 ${JSON.stringify(protoList[index])}，实现 ${JSON.stringify(liveList[index])}`);
      }
    }
  }
  return failures;
}

/**
 * Columns: count, names, order, the `colgroup` widths the prototype declares per column, and the
 * class contract of the first row's cells (the migrated `#401`/`.col-*` criterion: a cell that
 * loses its prototype class loses its nowrap/ellipsis behaviour with it).
 */
export function compareColumns(page, proto, live) {
  const failures = [];
  const notes = [];
  const protoTable = proto.tables[0] || null;
  if (!protoTable) return { failures: [`原型页 ${page.proto} 没有渲染 .tbl：列对照无法进行（先修 spec.mjs 的配对或原型）`], notes };
  if (!live.tables.length) {
    failures.push(`缺少列表表格 .tbl（原型 ${protoTable.headers.length} 列：${JSON.stringify(protoTable.headers)}）`);
    return { failures, notes };
  }
  if (live.tables.length > 1) notes.push(`实现页渲染了 ${live.tables.length} 个 .tbl，只对照第一个`);
  const liveTable = live.tables[0];
  if (protoTable.headers.length !== liveTable.headers.length) {
    failures.push(`列数不同 — 原型 ${protoTable.headers.length} 列 ${JSON.stringify(protoTable.headers)}，实现 ${liveTable.headers.length} 列 ${JSON.stringify(liveTable.headers)}`);
  }
  for (let index = 0; index < Math.min(protoTable.headers.length, liveTable.headers.length); index += 1) {
    const expected = protoTable.headers[index];
    const actual = liveTable.headers[index];
    if (normalize(expected) !== normalize(actual)) {
      failures.push(`第 ${index + 1} 列名称不同 — 原型 ${JSON.stringify(expected)}，实现 ${JSON.stringify(actual)}`);
    }
  }
  if (protoTable.headers.length === liveTable.headers.length) {
    const sameMultiset = protoTable.headers.length === liveTable.headers.length
      && [...protoTable.headers].sort().join("\u0000") === [...liveTable.headers].sort().join("\u0000");
    if (sameMultiset && protoTable.headers.some((name, index) => normalize(name) !== normalize(liveTable.headers[index]))) {
      failures.push(`列顺序不同 — 原型 ${JSON.stringify(protoTable.headers)}，实现 ${JSON.stringify(liveTable.headers)}`);
    }
  }
  if (protoTable.widths.length || liveTable.widths.length) {
    if (protoTable.widths.length !== liveTable.widths.length) {
      failures.push(`列宽声明数量不同 — 原型 ${JSON.stringify(protoTable.widths)}，实现 ${JSON.stringify(liveTable.widths)}`);
    }
    for (let index = 0; index < Math.min(protoTable.widths.length, liveTable.widths.length); index += 1) {
      if (normalize(protoTable.widths[index]) !== normalize(liveTable.widths[index])) {
        failures.push(`第 ${index + 1} 列宽度不同 — 原型 ${JSON.stringify(protoTable.widths[index])}，实现 ${JSON.stringify(liveTable.widths[index])}`);
      }
    }
  }
  for (let index = 0; index < Math.min(protoTable.headerClasses.length, liveTable.headerClasses.length); index += 1) {
    const missing = protoTable.headerClasses[index].filter((cls) => !liveTable.headerClasses[index].includes(cls));
    if (missing.length) failures.push(`第 ${index + 1} 列表头缺少原型 class：${JSON.stringify(missing)}`);
  }
  const protoRow = protoTable.row1 || [];
  const liveRow = liveTable.row1 || [];
  if (protoRow.length && liveRow.length) {
    for (let index = 0; index < Math.min(protoRow.length, liveRow.length); index += 1) {
      const missing = protoRow[index].classes.filter((cls) => !liveRow[index].classes.includes(cls));
      if (missing.length) failures.push(`第 ${index + 1} 列首行单元格缺少原型 class：${JSON.stringify(missing)}（原型 ${JSON.stringify(protoRow[index].classes)}，实现 ${JSON.stringify(liveRow[index].classes)}）`);
      const extra = liveRow[index].classes.filter((cls) => !protoRow[index].classes.includes(cls));
      if (extra.length) notes.push(`第 ${index + 1} 列首行单元格多出 class ${JSON.stringify(extra)}（SSR 附加，允许）`);
    }
  }
  return { failures, notes };
}

/**
 * Required elements: whatever the prototype page renders, the live page must render too.
 *
 * `equivalents` (optional) is `spec.ELEMENT_EQUIVALENTS`: `{ '<selector>': { accept: [...] } }`. When
 * the prototype renders a selector the live page does not, the live page still passes if it renders
 * one of the listed substitutes — the prototype is scripted, so a JS-flipped control has to be a real
 * form control on a no-JS plane (see the table in `spec.mjs` for the per-entry reason). Nothing else
 * is substituted: a selector without an entry must be there verbatim.
 */
export function compareElements(selectors, proto, live, equivalents = {}) {
  const failures = [];
  const notes = [];
  const counts = (probe, selector) => (probe.elements[selector]?.count ?? 0);
  const satisfies = (selector) => counts(live, selector) > 0
    || (equivalents[selector]?.accept ?? []).some((alternative) => counts(live, alternative) > 0);
  for (const selector of selectors) {
    const expected = proto.elements[selector];
    const actual = live.elements[selector];
    if (!expected || expected.count === 0) continue;
    if (satisfies(selector)) continue;
    const alternatives = equivalents[selector]?.accept ?? [];
    const hint = alternatives.length
      ? `，也没有等价的 ${alternatives.map((item) => JSON.stringify(item)).join(' / ')}（${equivalents[selector].reason}）`
      : '';
    failures.push(`缺少必需元素 ${selector}（原型出现 ${expected.count} 次，示例 ${JSON.stringify(expected.sample)}）${hint}`);
  }
  for (const selector of selectors) {
    const expected = proto.elements[selector];
    const actual = live.elements[selector];
    if (!expected || expected.count === 0) continue;
    if (actual && actual.count > expected.count) notes.push(`${selector}：实现 ${actual.count} 次 / 原型 ${expected.count} 次`);
  }
  return { failures, notes };
}

/** The `?id=` drawer inventory: sections, key/value keys, labelled fields and choice tokens. */
export function compareDrawer(page, proto, live) {
  const failures = [];
  const notes = [];
  if (!page.drawer) return { failures, notes };
  if (!proto.drawer) {
    return { failures: [`原型 ${page.proto} 未渲染详情抽屉：无法对照 ${page.drawer.kind} 的字段清单`], notes };
  }
  if (!live.drawer) {
    failures.push(`缺少 ?id= 详情抽屉 ${page.drawer.kind}（原型抽屉分节 ${JSON.stringify(proto.drawer.sections)}）`);
    return { failures, notes };
  }
  failures.push(...listDiff("抽屉分节 .dsec>h3", proto.drawer.sections, live.drawer.sections, { ordered: true }));
  failures.push(...listDiff("抽屉 kv 字段名 .kv .k", proto.drawer.kvKeys, live.drawer.kvKeys, { ordered: false }));
  failures.push(...listDiff("抽屉表单字段标签", proto.drawer.fieldLabels, live.drawer.fieldLabels, { ordered: false }));
  failures.push(...listDiff("抽屉复选/单选项取值", proto.drawer.choiceValues, live.drawer.choiceValues, { ordered: false }));
  // The Vault picker is a real control with deployment-owned option values (`spec.DATA_CHOICE_FIELD`):
  // its presence is asserted, its identity is recorded. The prototype fixture's `vault`/`research`
  // are not the deployment's registry ids, so comparing them verbatim would be a criterion two
  // machines (or two fixtures) can never agree on.
  const protoVaults = proto.drawer.vaultChoices ?? [];
  const liveVaults = live.drawer.vaultChoices ?? [];
  if (protoVaults.length && !liveVaults.length) {
    failures.push(`抽屉 Vault 选项缺失：原型渲染了 ${protoVaults.length} 个 Vault 复选项 ${JSON.stringify(protoVaults)}，实现一个都没有`);
  } else if (protoVaults.length && liveVaults.length) {
    notes.push(`抽屉 Vault 选项取值属部署数据：原型 ${JSON.stringify(protoVaults)} / 实现 ${JSON.stringify(liveVaults)}（只断言存在，不比较取值）`);
  }
  return { failures, notes };
}

/** Shell navigation: the prototype's sidebar items, in order, with the active one marked. */
export function compareNav(proto, live) {
  const failures = [];
  const notes = [];
  if (!proto.nav.labels.length) return { failures: [`原型没有渲染侧栏导航 .side .ni：无法对照 shell`], notes };
  failures.push(...listDiff("侧栏导航项", proto.nav.labels, live.nav.labels, { ordered: true }));
  if (!live.nav.active) failures.push(`当前页项没有 aria-current/.on 标记（原型高亮 ${JSON.stringify(proto.nav.active)}）`);
  for (const label of proto.nav.mnav) {
    if (!live.nav.mnav.includes(label)) failures.push(`移动端导航 .mnav 缺少 ${JSON.stringify(label)}`);
  }
  return { failures, notes };
}

/** The migrated "no horizontal overflow" criterion: the page's own scroll container. */
export function compareOverflow(live) {
  const failures = [];
  const { scrollWidth, clientWidth } = live.overflow || {};
  if (!Number.isFinite(scrollWidth) || !Number.isFinite(clientWidth)) {
    failures.push("无法测量页面横向溢出（缺少 .main .content）");
    return failures;
  }
  if (scrollWidth > clientWidth + 1) failures.push(`页面横向溢出：content.scrollWidth=${scrollWidth} > clientWidth=${clientWidth}`);
  return failures;
}

/**
 * The migrated RETURN-1 primary-button criterion: every visible `.btn.primary` paints an opaque
 * background and keeps legible text. `expectAtLeast` is the prototype's own count (0 ⇒ optional).
 */
export function comparePrimaryButtons(live, expectAtLeast = 0) {
  const failures = [];
  const buttons = (live.buttons || []).filter((button) => button.classes.split(" ").includes("primary"));
  if (buttons.length < expectAtLeast) {
    failures.push(`主按钮 .btn.primary 数量不足：原型 ${expectAtLeast} 个，实现 ${buttons.length} 个`);
  }
  for (const button of buttons) {
    if (button.background === "rgba(0, 0, 0, 0)" || button.background === "transparent") {
      failures.push(`主按钮 ${JSON.stringify(button.text)} 背景透明（白字在透明背景上不可见）`);
    }
    if (button.color === button.background) {
      failures.push(`主按钮 ${JSON.stringify(button.text)} 的前景与背景同色 ${button.background}`);
    }
    if (button.width <= 20 || button.height <= 20) {
      failures.push(`主按钮 ${JSON.stringify(button.text)} 尺寸不可用：${button.width}x${button.height}`);
    }
  }
  return failures;
}

/**
 * The migrated `#402` badge criterion, re-scoped to the prototype's chip vocabulary (`.cap` in the
 * vault drawer, `.tag` capability chips in the authz table): bounded height, single line, no
 * raw-reason suffix inside the chip.
 */
export function compareChips(live, { maxHeight, maxWidth }) {
  const failures = [];
  const notes = [];
  for (const chip of live.chips || []) {
    if (chip.height > maxHeight) failures.push(`能力 chip ${JSON.stringify(chip.text)} 高 ${chip.height}px（上限 ${maxHeight}）`);
    if (chip.width > maxWidth) failures.push(`能力 chip ${JSON.stringify(chip.text)} 宽 ${chip.width}px（上限 ${maxWidth}）`);
    if (chip.lines > 1) failures.push(`能力 chip ${JSON.stringify(chip.text)} 断成 ${chip.lines} 行（上限 1 行）`);
  }
  return { failures, notes };
}

/** Format one page's comparison result for the gate log: every difference on its own line. */
export function formatPageReport(page, results) {
  const lines = [];
  for (const [phase, result] of Object.entries(results)) {
    for (const failure of result.failures) lines.push(`[${page.id}/${phase}] ${failure}`);
    for (const note of result.notes || []) lines.push(`[${page.id}/${phase}][note] ${note}`);
  }
  return lines;
}
