// Synthetic, self-contained Base query fixtures for the A1 characterization
// tests. Every value here is invented for the test and contains no real user
// Vault content.

import fs from "node:fs/promises";
import path from "node:path";

function note(frontmatter, body = "") {
  const keys = Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  return `---\n${keys}\n---\n${body}`;
}

// A depth-25 nested-if formula, used to prove the depth guard fails closed.
function deepFormula() {
  let expression = "file.name";
  for (let index = 0; index < 25; index += 1) expression = `if(title, ${expression}, file.name)`;
  return `formulas:\n  note: file.asLink(${expression})\nviews:\n  - type: table\n    name: Bad\n    order: [formula.note]\n`;
}

// name -> file content. Paths are relative to the synthetic vault root.
export function baseFixtureFiles() {
  return {
    // --- Not matched by the WB folder filter ---------------------------------
    "Other/Outside.md": note({ type: "doc", status: "active" }, "# Outside\n"),

    // --- WB notes ------------------------------------------------------------
    "WB/One.md": note(
      {
        title: "One Title",
        type: "doc",
        status: "active",
        priority: "P1",
        score: 5,
        updated: "2026-09-01",
        tags: "[work, alpha]",
        categories: "[red, blue]",
      },
      "# One\n\nLink [[Two]] and [[Three|Alias]].\n",
    ),
    "WB/Two.md": note(
      { name: "Two Named", type: "doc", status: "active", priority: "P2", score: 9, updated: "2026-09-03", categories: "[green]" },
      "# Two\n\ninline #work tag.\n",
    ),
    "WB/Three.md": note(
      { title: '""', type: "note", status: "deferred", priority: "P1", updated: "2026-09-02" },
      "# Three\n\n#beta\n",
    ),
    "WB/Four.md": note({ type: "note", status: "done", priority: "P3", updated: "2026-09-04", tags: "[work]" }, "# Four\n"),
    "WB/Five.md": note({ type: "doc", status: "active", priority: "P1", updated: "2026-09-05" }, "# Five\n\n[[One]]\n"),
    "WB/Six.md": note({ type: "doc", status: "active", priority: "P1", updated: "2026-09-05" }, "# Six\n"),
    "WB/Listed.md": note({ title: '["One", "Two"]', type: "doc", status: "active", updated: "2026-09-06" }, "# Listed\n"),
    "WB/Numeric.md": note({ title: "2026", type: "doc", status: "active", updated: "2026-09-07" }, "# Numeric\n"),
    "WB/Flagged.md": note({ title: "true", type: "doc", status: "active", updated: "2026-09-08" }, "# Flagged\n"),
    "WB/Map.md": note({ title: "{nested: true}", type: "doc", status: "active", updated: "2026-09-09" }, "# Map\n"),
    "WB/Blank.md": note({ type: "doc", status: "active", updated: "2026-09-10" }, "# Blank\n"),
    "WB/Sub/Deep.md": note({ title: "Deep Title", type: "doc", status: "active", updated: "2026-09-11" }, "# Deep\n"),

    // --- Valid Bases ---------------------------------------------------------
    "NoViews.base": 'filters: file.inFolder("WB")\n',

    "Default.base": [
      'filters: file.inFolder("WB")',
      "views:",
      "  - type: table",
      "    name: First",
      "    order:",
      "      - file.name",
      "      - status",
      "    sort:",
      "      - property: file.name",
      "        direction: ASC",
      "  - type: table",
      "    name: Second",
      "    order:",
      "      - file.path",
      "    sort:",
      "      - property: file.name",
      "        direction: DESC",
      "",
    ].join("\n"),

    "Filters.base": [
      'filters: file.inFolder("WB")',
      "views:",
      "  - type: table",
      "    name: Combined",
      "    filters:",
      "      and:",
      '        - file.name.startsWith("F")',
      '        - status == "active"',
      "    order:",
      "      - file.name",
      "      - priority",
      "      - status",
      "",
    ].join("\n"),

    "Logic.base": [
      "filters:",
      "  and:",
      '    - file.inFolder("WB")',
      "    - not:",
      '        - status == "deferred"',
      "views:",
      "  - type: table",
      "    name: Logic",
      "    filters:",
      "      or:",
      '        - file.hasTag("work")',
      '        - file.hasLink("One")',
      '        - categories.contains("red")',
      "    order:",
      "      - file.name",
      "      - status",
      "      - priority",
      "",
    ].join("\n"),

    "Sort.base": [
      'filters: file.inFolder("WB")',
      "views:",
      "  - type: table",
      "    name: SortAsc",
      "    order:",
      "      - file.name",
      "      - priority",
      "      - updated",
      "    sort:",
      "      - property: priority",
      "        direction: ASC",
      "      - property: updated",
      "        direction: DESC",
      "  - type: table",
      "    name: SortDesc",
      "    order:",
      "      - file.name",
      "    sort:",
      "      - property: file.name",
      "        direction: DESC",
      "",
    ].join("\n"),

    "Formula.base": [
      'filters: file.inFolder("WB")',
      "formulas:",
      "  note: file.asLink(if(title, title, file.name))",
      "properties:",
      "  formula.note:",
      "    displayName: Note",
      "views:",
      "  - type: table",
      "    name: Formula",
      "    order:",
      "      - formula.note",
      "      - file.name",
      "      - type",
      "",
    ].join("\n"),

    "Nested.base": [
      'filters: file.inFolder("WB")',
      "formulas:",
      "  note: file.asLink(if(title, title, if(name, name, file.name)))",
      "views:",
      "  - type: table",
      "    name: Nested",
      "    order:",
      "      - formula.note",
      "",
    ].join("\n"),

    "AsLinkName.base": [
      'filters: file.inFolder("WB")',
      "formulas:",
      "  link: file.asLink(file.name)",
      "views:",
      "  - type: table",
      "    name: Name",
      "    order:",
      "      - formula.link",
      "",
    ].join("\n"),

    "AsLinkProperty.base": [
      'filters: file.inFolder("WB")',
      "formulas:",
      "  link: file.asLink(title)",
      "views:",
      "  - type: table",
      "    name: Title",
      "    order:",
      "      - formula.link",
      "      - file.name",
      "",
    ].join("\n"),

    "Limit.base": [
      'filters: file.inFolder("WB")',
      "views:",
      "  - type: table",
      "    name: Limited",
      "    limit: 2",
      "    order:",
      "      - file.name",
      "    sort:",
      "      - property: file.name",
      "        direction: ASC",
      "",
    ].join("\n"),

    // Many equal `status` values plus one missing `priority`, so this Base
    // exercises the stable final path ASC tie-break and null-last ordering.
    "TieBreak.base": [
      'filters: file.inFolder("WB")',
      "views:",
      "  - type: table",
      "    name: Tie",
      "    order:",
      "      - file.name",
      "      - status",
      "    sort:",
      "      - property: status",
      "        direction: ASC",
      "",
    ].join("\n"),

    // --- Fail-closed Bases ---------------------------------------------------
    "Bad/UnsupportedFileProp.base": 'filters: file.inFolder("WB")\nformulas:\n  note: file.asLink(file.path)\nviews:\n  - type: table\n    name: Bad\n    order: [formula.note]\n',
    "Bad/FormulaRef.base": "formulas:\n  note: file.asLink(formula.other)\nviews:\n  - type: table\n    name: Bad\n    order: [formula.note]\n",
    // INT-B: a DECLARED `formula.<name>` dependency is supported (positive fixture).
    "FormulaRef.base": 'filters: file.inFolder("WB")\nformulas:\n  base: file.asLink(if(title, title, file.name))\n  note: file.asLink(formula.base + "!")\nviews:\n  - type: table\n    name: FormulaRef\n    order:\n      - formula.note\n',
    "Bad/NoteNamespace.base": "formulas:\n  note: file.asLink(note.title)\nviews:\n  - type: table\n    name: Bad\n    order: [formula.note]\n",
    "Bad/TrueLiteral.base": "formulas:\n  note: file.asLink(if(true, title, file.name))\nviews:\n  - type: table\n    name: Bad\n    order: [formula.note]\n",
    "Bad/UnknownFunction.base": "formulas:\n  note: file.asLink(sum(title, name))\nviews:\n  - type: table\n    name: Bad\n    order: [formula.note]\n",
    "Bad/Malformed.base": "formulas:\n  note: 'file.asLink(if(title, title))'\nviews:\n  - type: table\n    name: Bad\n    order: [formula.note]\n",
    "Bad/Deep.base": deepFormula(),
    "Bad/SortFormula.base": 'filters: file.inFolder("WB")\nformulas:\n  note: file.asLink(if(title, title, file.name))\nviews:\n  - type: table\n    name: Bad\n    order: [formula.note]\n    sort:\n      - property: formula.note\n        direction: ASC\n',
    "Bad/FilterFormula.base": 'filters: formula.note == "x"\nformulas:\n  note: file.asLink(if(title, title, file.name))\nviews:\n  - type: table\n    name: Bad\n    order: [formula.note]\n',
    "Bad/MissingOrderFormula.base": 'filters: file.inFolder("WB")\nviews:\n  - type: table\n    name: Bad\n    order: [formula.note]\n',
    "Bad/FilterObject.base": 'filters:\n  xor:\n    - status == "active"\nviews:\n  - type: table\n    name: Bad\n    order: [file.name]\n',
    "Bad/FilterExpression.base": 'filters: title.matches("One")\nviews:\n  - type: table\n    name: Bad\n    order: [file.name]\n',
    "Bad/SortConfig.base": 'filters: file.inFolder("WB")\nviews:\n  - type: table\n    name: Bad\n    order: [file.name]\n    sort:\n      - direction: ASC\n',
    "Bad/InvalidRoot.base": "- a\n- b\n",
    "Bad/InvalidViews.base": "views: {}\n",
    "Bad/MissingViewName.base": "views:\n  - type: table\n",
    "Bad/MissingViewType.base": "views:\n  - name: NoType\n",
    "Bad/InvalidYaml.base": "views: [\n",
  };
}

// Write every fixture under `vaultRoot`, creating parent directories.
export async function writeBaseFixtures(vaultRoot) {
  const files = baseFixtureFiles();
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(vaultRoot, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, "utf8");
  }
  return files;
}
