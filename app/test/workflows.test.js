import assert from "node:assert/strict";
import test from "node:test";
import { BaseFormulaError, compileBaseFormulas, evaluateBaseFormula, formulaDisplayName, isFormulaTruthy, parseBaseFormula } from "../src/base-formulas.js";
import { baseRow, evaluateBaseFilter, formatObsidianDate, parseTasks, renderTemplate, sortBaseRecords, updateTaskLine } from "../src/workflows.js";

test("tasks preserve vault file line numbers and ignore fenced examples", () => {
  const raw = "---\ntags: [test]\n---\n- [ ] real task\n```md\n- [ ] example\n```\n- [x] done";
  const tasks = parseTasks(raw, "Tasks.md");
  assert.deepEqual(tasks.map((task) => [task.line, task.status, task.text]), [[4, " ", "real task"], [8, "x", "done"]]);
});

test("task update changes only the requested checkbox", () => {
  const updated = updateTaskLine("- [ ] one\n- [x] two", 1, "toggle");
  assert.equal(updated.raw, "- [x] one\n- [x] two");
  assert.equal(updated.previousStatus, " ");
});

test("Obsidian date and template variables honor timezone", () => {
  const date = new Date("2026-08-29T16:30:00.000Z");
  assert.equal(formatObsidianDate(date, "YYYY-MM-DD HH:mm", "Asia/Shanghai"), "2026-08-30 00:30");
  assert.equal(renderTemplate("# {{title}}\n{{date:YYYY-MM-DD}} {{owner}}", { date, title: "Daily", variables: { owner: "OhiyoX" }, timeZone: "Asia/Shanghai" }), "# Daily\n2026-08-30 OhiyoX");
});

test("portable Base filters support nested logic and file helpers", () => {
  const record = {
    path: "Projects/Alpha.md",
    basename: "Alpha",
    frontmatter: { status: "active", score: 8 },
    tags: ["work"],
    links: [{ target: "Home" }],
    stat: { size: 100, created: "2026-01-01", modified: "2026-01-02" },
  };
  assert.equal(evaluateBaseFilter({ and: ['file.inFolder("Projects")', 'file.hasTag("work")', 'status == "active"', "score >= 5"] }, record), true);
  assert.equal(evaluateBaseFilter({ not: ['file.hasLink("Home")'] }, record), false);
  assert.equal(evaluateBaseFilter('file.name.startsWith("Al")', record), true);
  assert.equal(evaluateBaseFilter('file.name.endsWith("pha")', record), true);
  assert.equal(evaluateBaseFilter('file.name.startsWith("Be")', record), false);
});

test("portable Base sort applies priority and recency before limiting rows", () => {
  const records = [
    { path: "c", frontmatter: { priority: "P2", updated: "2026-09-23" } },
    { path: "b", frontmatter: { priority: "P1", updated: "2026-09-20" } },
    { path: "a", frontmatter: { priority: "P1", updated: "2026-09-22" } },
    { path: "d", frontmatter: { updated: "2026-09-23" } },
  ];
  const sort = [{ property: "priority", direction: "ASC" }, { property: "updated", direction: "DESC" }];
  assert.deepEqual(sortBaseRecords(records, sort).map((record) => record.path), ["a", "b", "c", "d"]);
  assert.deepEqual(records.map((record) => record.path), ["c", "b", "a", "d"]);
  const dates = [
    { path: "old", frontmatter: { updated: new Date("2026-09-20") } },
    { path: "new", frontmatter: { updated: "2026-09-23" } },
  ];
  assert.deepEqual(sortBaseRecords(dates, [{ property: "updated", direction: "DESC" }]).map((record) => record.path), ["new", "old"]);
});

test("Base formula parser accepts only the documented portable grammar", () => {
  const ast = parseBaseFormula("file.asLink(if(title, title, file.name))");
  assert.equal(ast.type, "asLink");
  assert.equal(ast.argument.type, "if");
  assert.equal(ast.argument.condition.name, "title");
  assert.equal(ast.argument.alternate.name, "file.name");
  assert.throws(() => parseBaseFormula("file.asLink2(title)"), /must start with file\.asLink/);
  assert.throws(() => parseBaseFormula("if(title, title, file.name)"), /must start with file\.asLink/);
  assert.throws(() => parseBaseFormula("file.asLink(if(title, title))"), /Expected/);
  assert.throws(() => parseBaseFormula("file.asLink(title) trailing"), /Unexpected token/);
  assert.throws(() => parseBaseFormula("file.asLink(title == \"x\")"), /Unexpected character/);
});

test("Base formula compiler supports note.* references and the P1-A literals, and still fails closed on undeclared references and depth overflow", () => {
  assert.throws(() => compileBaseFormulas({ note: "file.asLink(file.path)" }), /unsupported file property/);
  // INT-B flipped the formula-reference half: `formula.<name>` is wired, so the
  // remaining compile-time failures are an UNDECLARED reference and a cycle.
  assert.throws(
    () => compileBaseFormulas({ note: "file.asLink(formula.other)" }),
    /references undeclared formula "other"/,
  );
  assert.throws(
    () => compileBaseFormulas({ a: "file.asLink(formula.b)", b: "file.asLink(formula.a)" }),
    /cycle detected: a -> b -> a/,
  );
  // Positive (INT-B): a declared dependency feeds the outer formula.
  const dependency = compileBaseFormulas({
    base: "file.asLink(price * 2)",
    doubled: "file.asLink(formula.base + 1)",
  });
  assert.equal(
    evaluateBaseFormula(dependency.doubled, { path: "Notes/A.md", basename: "A", frontmatter: { price: 3 } }).displayName,
    "7",
  );
  // INT-A wired the `note.<prop>` namespace and the P1-A literal engine: `note.title`
  // is equivalent to the bare property and `true`/`false`/`null` are typed literals
  // (no longer reserved words of a fail-closed grammar). The full capability matrix
  // lives in `base-int-a-expressions.test.js`.
  const literalFormulas = compileBaseFormulas({
    noteNamespace: "file.asLink(if(note.title, note.title, file.name))",
    trueLiteral: "file.asLink(if(true, title, file.name))",
    falseLiteral: "file.asLink(if(title, title, false))",
    nullLiteral: "file.asLink(if(title, title, null))",
  });
  const literalRecord = { path: "Folder/Note.md", basename: "Note", frontmatter: { title: "Display" } };
  const literalDisplay = (name) => evaluateBaseFormula(literalFormulas[name], literalRecord, literalFormulas).displayName;
  assert.equal(literalDisplay("noteNamespace"), "Display");
  assert.equal(literalDisplay("trueLiteral"), "Display");
  assert.equal(literalDisplay("falseLiteral"), "Display");
  assert.equal(literalDisplay("nullLiteral"), "Display");
  assert.throws(() => compileBaseFormulas({ note: "file.asLink(file.asLink(title))" }), /Expected|unsupported/);
  assert.throws(() => compileBaseFormulas({ note: "file.asLink(if(title, file.name, file.unknown))" }), /file\.unknown/);
  let nested = "file.name";
  for (let index = 0; index < 25; index += 1) nested = `if(title, ${nested}, file.name)`;
  assert.throws(() => compileBaseFormulas({ note: `file.asLink(${nested})` }), /nesting|depth/i);
  assert.throws(() => compileBaseFormulas({ note: 42 }), /must be a string/);
  assert.throws(() => compileBaseFormulas([]), /mapping/);
  assert.deepEqual(Object.keys(compileBaseFormulas(undefined)), []);
});

test("Base formula compiler validates unused formulas and dead branches before evaluation", () => {
  // INT-B flipped the reference half of this test: an UNDECLARED `formula.<name>`
  // is the remaining compile-time failure (cycles are covered above).
  assert.throws(
    () => compileBaseFormulas({ unused: "file.asLink(formula.other)" }),
    /references undeclared formula "other"/,
  );
  assert.throws(
    () => compileBaseFormulas({ note: "file.asLink(if(title, file.name, formula.other))" }),
    /references undeclared formula "other"/,
  );
  // A declared dependency inside an unused formula / dead branch resolves.
  const declared = compileBaseFormulas({
    dep: "file.asLink(price + 1)",
    unused: "file.asLink(formula.dep * 2)",
    note: "file.asLink(if(title, file.name, formula.dep))",
  });
  assert.equal(
    evaluateBaseFormula(declared.unused, { path: "Notes/A.md", basename: "A", frontmatter: { price: 3 } }).displayName,
    "8",
  );
});

test("Base formula truthiness and non-string display behavior are explicit", () => {
  assert.equal(isFormulaTruthy(undefined), false);
  assert.equal(isFormulaTruthy(null), false);
  assert.equal(isFormulaTruthy(""), false);
  assert.equal(isFormulaTruthy("   "), false);
  assert.equal(isFormulaTruthy(0), false);
  assert.equal(isFormulaTruthy(Number.NaN), false);
  assert.equal(isFormulaTruthy([]), false);
  assert.equal(isFormulaTruthy("x"), true);
  assert.equal(isFormulaTruthy(3), true);
  assert.equal(isFormulaTruthy(false), false);
  assert.equal(isFormulaTruthy({}), true);
  assert.equal(formulaDisplayName("value", "fallback"), "value");
  assert.equal(formulaDisplayName("  ", "fallback"), "fallback");
  assert.equal(formulaDisplayName(2026, "fallback"), "2026");
  assert.equal(formulaDisplayName(true, "fallback"), "true");
  assert.equal(formulaDisplayName(["One", "Two"], "fallback"), "One, Two");
  assert.equal(formulaDisplayName([], "fallback"), "fallback");
  assert.equal(formulaDisplayName({ nested: true }, "fallback"), "fallback");
  assert.equal(formulaDisplayName(Number.NaN, "fallback"), "fallback");
});

test("Base formula evaluation returns structured cells and never invokes accessors", () => {
  const compiled = compileBaseFormulas({ note: "file.asLink(if(title, title, file.name))" });
  const record = { path: "Folder/Note.md", basename: "Note", frontmatter: { title: "Display" } };
  assert.deepEqual(evaluateBaseFormula(compiled.note, record, compiled), { path: "Folder/Note.md", displayName: "Display", kind: "asLink" });

  const frontmatter = {};
  Object.defineProperty(frontmatter, "title", { enumerable: true, get() { throw new Error("accessor must not run"); } });
  const accessorRecord = { path: "Folder/Getter.md", basename: "Getter", frontmatter };
  assert.deepEqual(evaluateBaseFormula(compiled.note, accessorRecord), { path: "Folder/Getter.md", displayName: "Getter", kind: "asLink" });

  const inherited = Object.create({ title: "prototype" });
  const inheritedRecord = { path: "Folder/Inherited.md", basename: "Inherited", frontmatter: inherited };
  assert.equal(evaluateBaseFormula(compiled.note, inheritedRecord).displayName, "Inherited");
});

test("baseRow resolves formula properties only when a compiled formula context is supplied", () => {
  const compiled = compileBaseFormulas({ note: "file.asLink(if(title, title, file.name))" });
  const record = { path: "Folder/Note.md", basename: "Note", frontmatter: { title: "Display" } };
  assert.deepEqual(baseRow(record, ["formula.note"], { formulas: compiled })["formula.note"], {
    path: "Folder/Note.md",
    displayName: "Display",
    kind: "asLink",
  });
  assert.equal(baseRow(record, ["formula.note"])["formula.note"], undefined);
  assert.throws(() => baseRow(record, ["formula.missing"], { formulas: compiled }), /missing formula "missing"/);
  assert.ok(BaseFormulaError.prototype instanceof Error);
});

test("Base formula compilation keeps hostile keys as own properties", () => {
  const compiled = compileBaseFormulas(JSON.parse('{"__proto__": "file.asLink(file.name)"}'));
  assert.equal(Object.getPrototypeOf(compiled), null);
  assert.equal(Object.hasOwn(compiled, "__proto__"), true);
  assert.equal({}.displayName, undefined);
});
