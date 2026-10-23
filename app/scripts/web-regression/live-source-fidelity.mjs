// Issue #484 鈥?Live Preview source fidelity: markers may hide, but text the user typed must not.
//
// Why this module exists (baseline RED, 2026-10-10): `extensions/live-decorations.js` keeps a
// `HIDDEN_MARKS` set that contains `URL` and `QuoteMark` unconditionally, and the idle branch of
// `buildLiveDecorations()` pushes `Decoration.replace({})` over the *whole* node. For a markdown
// link `[text](target)` the `URL` node is chrome, so hiding it is right; for an **autolink**
// `<https://example.com/autolink>` the `URL` node *is* the visible text, so the same rule deletes
// content the user typed. The two checks below pin both halves: the autolink must stay readable,
// and the link target must stay hidden (so the fix cannot be "stop hiding URL nodes").
//
// Registered by scripts/web-regression.mjs after the other editor scenes on the shared page.
import assert from "node:assert/strict";

/** Visible text of the editor surface (rendered DOM, not the source buffer). */
async function visibleText(page) {
  return page.evaluate(() => document.querySelector(".cm-content")?.innerText ?? "");
}

async function caretToStart(page) {
  await page.evaluate(() => {
    const view = window.__testEditor._view;
    view.dispatch({ selection: { anchor: 0 } });
  });
}

/** The rendered line texts of the Live surface, trimmed (idle chrome is spacing-free). */
async function visibleLines(page) {
  return page.evaluate(() => [...document.querySelectorAll(".cm-content .cm-line")].map((line) => line.textContent.trim()));
}

export async function registerLiveSourceFidelityChecks(ctx) {
  const { check, sleep, page, open, mode, value } = ctx;

  await check("WSF-01 idle Live Preview keeps an autolink's text (#484: URL node must not be deleted)", async () => {
    await open("A.md");
    await mode("live");
    await caretToStart(page);
    await sleep(150);
    const text = await visibleText(page);
    assert.match(
      text,
      /https:\/\/example\.com\/autolink/,
      `the autolink target is user-visible text and must survive idle Live Preview; visible text was: ${JSON.stringify(text.slice(0, 300))}`,
    );
    // The email autolink on the same line is the same node kind (#484's report mentions bare URLs).
    assert.match(text, /tester@example\.com/, `the email autolink must survive idle Live Preview too; visible text was: ${JSON.stringify(text.slice(0, 300))}`);
    assert.equal(await value(), ctx.fixture, "the source buffer must be untouched by rendering");
  });

  await check("WSF-02 the markdown link target stays hidden when idle (#484 guard: do not stop hiding chrome)", async () => {
    // Self-sufficient on purpose (pi-h2 review): the check re-establishes its own page state so
    // that running it alone (WEB_TEST_ONLY on this name) exercises the same precondition.
    await open("A.md");
    await mode("live");
    await caretToStart(page);
    await sleep(150);
    const text = await visibleText(page);
    // Cover both spellings of the fixture target: a matching-title link would hide title and
    // target alike, so pinning only the titled form could go stale if the fixture drops the title.
    for (const target of ['(https://example.com)', '(https://example.com "Example")']) {
      assert.ok(
        !text.includes(target),
        `a link target is chrome and must stay hidden while the caret is elsewhere; ${JSON.stringify(target)} leaked into: ${JSON.stringify(text.slice(0, 300))}`,
      );
    }
    assert.match(text, /external link/, "hiding the target must not hide the link text");
  });

  await check("WSF-03 highlight markers do not leak while their content stays (#484 marker leak, first half)", async () => {
    await open("A.md");
    await mode("live");
    await caretToStart(page);
    await sleep(150);
    const text = await visibleText(page);
    assert.match(text, /highlight/, "the highlighted content must stay visible");
    assert.doesNotMatch(text, /==highlight==/, `the == markers must not leak in idle Live Preview; visible text was: ${JSON.stringify(text.slice(0, 300))}`);
    assert.equal(await value(), ctx.fixture, "the source buffer must be untouched by rendering");
  });

  // Desktop Live Preview (owner screenshots, 2026-10-10) keeps `%%鈥?%` fully visible but dimmed 鈥?  // it is NOT hidden, so the Web equivalent must also keep both markers and content on screen.
  await check("WSF-04 a comment stays visible (dimmed) in idle Live Preview, like Desktop", async () => {
    await open("A.md");
    await mode("live");
    await caretToStart(page);
    // CodeMirror only renders the viewport, so scroll the comment into view before judging it.
    const commentPos = await page.evaluate(() => window.__testEditor._view.state.doc.toString().indexOf("%% private %%"));
    assert.ok(commentPos > 0, "the fixture must contain the comment line this check is about");
    await page.evaluate((pos) => window.__testEditor.scrollToPosition(pos), commentPos);
    await sleep(250);
    const text = await visibleText(page);
    assert.match(text, /%%\s*private\s*%%/, `Desktop keeps the %% delimiters visible (dimmed); visible text was: ${JSON.stringify(text.slice(0, 400))}`);
    const dimmed = await page.evaluate(() => {
      const node = document.querySelector(".cm-obsidian-comment");
      if (!node) return null;
      return { color: getComputedStyle(node).color, body: getComputedStyle(document.querySelector(".cm-content") || document.body).color };
    });
    assert.ok(dimmed, "the comment must be decorated as a comment");
    assert.notEqual(dimmed.color, dimmed.body, `the comment must be dimmed like Desktop, not full-strength body text (${JSON.stringify(dimmed)})`);
    await caretToStart(page);
    assert.equal(await value(), ctx.fixture, "the source buffer must be untouched by rendering");
  });

  // Owner truth (2026-10-10, verbatim): "缂栬緫鏃?==灞曞紑锛屾湭灏卞湴缂栬緫鏃跺彧鏈夐珮浜鑹? 鈥?in Live Preview the
  // markers hide while the span is idle and expand to literal source once the caret is inside it.
  // WSF-03 pins the idle half; this pins the editing half, so the two cannot drift apart.
  await check("WSF-05 the == markers expand again while the caret is inside the span", async () => {
    await open("A.md");
    await mode("live");
    const spanPos = await page.evaluate(() => window.__testEditor._view.state.doc.toString().indexOf("==highlight=="));
    assert.ok(spanPos > 0, "the fixture must contain the highlight span this check is about");
    await page.evaluate((pos) => {
      const view = window.__testEditor._view;
      view.dispatch({ selection: { anchor: pos + 4 } });
      view.focus();
    }, spanPos);
    await sleep(200);
    const text = await visibleText(page);
    assert.match(text, /==highlight==/, `with the caret inside, Desktop expands the markers; visible text was: ${JSON.stringify(text.slice(0, 300))}`);
    await caretToStart(page);
    assert.equal(await value(), ctx.fixture, "moving the caret must not touch the source");
  });

  // Owner truth (2026-10-10 screenshot): idle `===a===` shows only `a`, highlighted. The caret
  // entering that span expands the literal `===a===`. `====a====` is the same rule with no owner
  // screenshot, so it is not asserted here (鎺ㄥ緱椤癸紝寰呯湡鍊?. Negative controls: a bare `====`
  // stays literal, and `==a=b==` still hides only its two-equals markers.
  await check("WSF-06 three-or-more equals delimiters hide on both sides while idle and expand when the caret enters", async () => {
    await open("A.md");
    await mode("live");
    const source = "before ===a=== after\n====\n==a=b==\n";
    await page.evaluate((text) => {
      window.__testEditor.setValue(text, { resetHistory: true, silent: true });
      window.__testEditor._view.dispatch({ selection: { anchor: 0 } });
    }, source);
    await sleep(200);
    const idle = await visibleText(page);
    const idleLines = idle.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    const spanLine = idleLines.find((line) => line.startsWith("before ")) || "";
    assert.equal(
      spanLine,
      "before a after",
      `idle ===a=== must show only a, with no leftover =; visible lines were ${JSON.stringify(idleLines)}`,
    );
    assert.equal(spanLine.includes("="), false, "the idle ===a=== line must not contain =");
    assert.ok(idleLines.includes("===="), `==== must stay literal; visible lines were ${JSON.stringify(idleLines)}`);
    assert.ok(idleLines.includes("a=b"), `==a=b== must still show its inner content; visible lines were ${JSON.stringify(idleLines)}`);
    assert.equal(idle.includes("==a=b=="), false, `==a=b== markers must stay hidden; visible text was ${JSON.stringify(idle.slice(0, 300))}`);
    const painted = await page.evaluate(() => [...document.querySelectorAll(".cm-obsidian-highlight")].map((node) => node.textContent));
    assert.deepEqual(painted, ["a", "a=b"], `highlight paint must use the same spans the hide path does; got ${JSON.stringify(painted)}`);
    await page.evaluate(() => {
      const view = window.__testEditor._view;
      const pos = view.state.doc.toString().indexOf("===a===");
      view.dispatch({ selection: { anchor: pos + 3 } });
      view.focus();
    });
    await sleep(200);
    const editing = await visibleText(page);
    assert.match(editing, /===a===/, `with the caret inside, Desktop expands ===a===; visible text was ${JSON.stringify(editing.slice(0, 300))}`);
    assert.equal(await value(), source, "moving the caret must not rewrite the source");
    await page.evaluate((text) => {
      window.__testEditor.setValue(text, { resetHistory: true, silent: true });
    }, ctx.fixture);
    await caretToStart(page);
  });

  // ALIGNED in #506/#507 (this replaces the former "NOT COVERED" note): the Web **Reading**
  // surface now shows `%%鈥?%` faint with both delimiters kept, like Desktop
  // (`reader.js` `obsidianComments`), and the LP-11 browser check in `editor-interaction.mjs`
  // was rewritten to that contract. No assertion in this file changed.

  // #484 items 鈶?鈶? the closing `##` of an ATX heading and the backslashes of a hard break /
  // escape. `LP-13` follows the editor-scene numbering (`LP-12` is the editing envelope in
  // `editing-envelope.mjs`); this module owns the #484 Live source-fidelity scenarios.
  //
  // Measured, not assumed (see the #484 report): the trailing `HeaderMark` is hidden by the same
  // `selectionActivatesContext` rule as the opening one, so the *asymmetric* symptom the issue
  // describes ("the head mark hides, the tail mark leaks") does not reproduce on this head. The
  // check therefore pins the idle contract, including the reveal half, so a future edit cannot
  // turn it into the reported leak unnoticed.
  await check("LP-13 idle Live hides the closing ## of a heading and the escape backslashes", async () => {
    await open("A.md");
    await mode("live");
    const source = "# Render parity fixture ##\n\nline one\\\nline two\n\n\\#escaped ok\n";
    // Caret at the very end: outside the heading, outside the hard-break line, outside the
    // escaped paragraph. This is the idle state the issue's screenshot is about.
    await page.evaluate((text) => {
      window.__testEditor.setValue(text, { resetHistory: true, silent: true });
      const view = window.__testEditor._view;
      view.dispatch({ selection: { anchor: view.state.doc.length } });
    }, source);
    await sleep(200);
    const idle = await visibleLines(page);
    assert.ok(idle.includes("Render parity fixture"), `the heading text must stay; lines were ${JSON.stringify(idle)}`);
    assert.equal(
      idle.some((line) => line.includes("##")),
      false,
      `no ATX marker may leak while the caret is elsewhere; lines were ${JSON.stringify(idle)}`,
    );
    assert.ok(idle.includes("line one"), `the hard-break line keeps its text; lines were ${JSON.stringify(idle)}`);
    assert.equal(
      idle.some((line) => line.includes("\\")),
      false,
      `no escape backslash may leak while the caret is elsewhere; lines were ${JSON.stringify(idle)}`,
    );
    assert.ok(idle.includes("#escaped ok"), `an escaped character keeps its literal face; lines were ${JSON.stringify(idle)}`);
    assert.equal(await value(), source, "hiding chrome must never rewrite the Markdown source");

    // The other half of the contract: the backslash comes back on the line holding the caret.
    await page.evaluate(() => {
      const view = window.__testEditor._view;
      const pos = view.state.doc.toString().indexOf("line one") + 4;
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
    });
    await sleep(200);
    const editing = await visibleLines(page);
    assert.ok(
      editing.some((line) => line === "line one\\"),
      `with the caret on that line Desktop shows the hard-break backslash again; lines were ${JSON.stringify(editing)}`,
    );
    assert.equal(await value(), source, "moving the caret must not rewrite the source");
    await page.evaluate((text) => window.__testEditor.setValue(text, { resetHistory: true, silent: true }), ctx.fixture);
    await caretToStart(page);
  });

  // #484 item 鈶? Reading renders `(#paren)` as a tag pill (`obsidianTags` allows `(`, `[`, `{`
  // before the `#`) while Live used to require whitespace, so the same source disagreed between
  // the two surfaces. Live now scans with the one shared lexer
  // (`features/document/inline-tag-lexicon.js`); the unit file
  // `test/inline-tag-lexicon-shared.test.js` proves both hosts agree token for token, and this
  // check proves the shipped bundle decorates the reported input.
  await check("LP-14 (#paren) and friends are Live tag pills, and link targets are not tags", async () => {
    await open("A.md");
    await mode("live");
    const source = "(#paren) and [#bracket] and {#curly} and #plain and #7 and word#glued\n\n[heading](#section)\n";
    await page.evaluate((text) => {
      window.__testEditor.setValue(text, { resetHistory: true, silent: true });
      window.__testEditor._view.dispatch({ selection: { anchor: 0 } });
    }, source);
    await sleep(200);
    const pills = await page.evaluate(() => [...document.querySelectorAll(".cm-content .cm-hashtag")]
      .map((node) => ({ text: node.textContent, className: node.className })));
    assert.deepEqual(
      pills.map((pill) => pill.text),
      ["#paren", "#bracket", "#curly", "#plain"],
      `the four delimiters Reading accepts must be pills in Live too; got ${JSON.stringify(pills)}`,
    );
    for (const pill of pills) {
      assert.match(pill.className, /cm-obsidian-tag/, "the pill keeps the canonical Live tag face");
      assert.ok(source.includes(pill.text), `${pill.text} must be source text, never an invented tag`);
    }
    const lines = await visibleLines(page);
    assert.ok(
      lines.some((line) => line === "(#paren) and #bracket and {#curly} and #plain and #7 and word#glued"),
      `a pill never rewrites or drops the surrounding text; lines were ${JSON.stringify(lines)}`,
    );
    // `#7` is an issue reference, not a tag; `word#glued` has no boundary before the `#`.
    assert.equal(pills.some((pill) => pill.text === "#7"), false, "a purely numeric tag stays text");
    // The link destination is literal text: Reading's markdown-it `link` rule consumes it before
    // the tag rule sees the `#`, and the Live scan excludes the Lezer destination nodes.
    assert.equal(
      pills.some((pill) => pill.text === "#section"),
      false,
      `a link destination must not become a tag; got ${JSON.stringify(pills)}`,
    );
    assert.equal(await value(), source, "the source buffer must be untouched by tag painting");
    await page.evaluate((text) => window.__testEditor.setValue(text, { resetHistory: true, silent: true }), ctx.fixture);
    await caretToStart(page);
  });

  // #484 item 鈶?(the content-loss half, re-measured here): the reported input was a *bare*
  // `http://x.com/#frag`, whose Lezer `URL` node hangs off `Paragraph` 鈥?not off `Autolink`. WSF-01
  // only covered the angle-bracket form, so the bare form was still deleted. It must stay visible
  // while a link/image destination stays hidden.
  await check("LP-15 a bare URL with a fragment stays visible in idle Live while a link target hides", async () => {
    await open("A.md");
    await mode("live");
    const source = "see http://x.com/#frag ok\n\n[a](https://x.com/target) and https://x.com/bare\n";
    // Caret on the first line's end: inside no link context, so the second line stays idle.
    await page.evaluate((text) => {
      window.__testEditor.setValue(text, { resetHistory: true, silent: true });
      window.__testEditor._view.dispatch({ selection: { anchor: 4 } });
    }, source);
    await sleep(200);
    const lines = await visibleLines(page);
    assert.ok(
      lines.some((line) => line === "see http://x.com/#frag ok"),
      `the bare URL is user-visible text and must survive idle Live Preview; lines were ${JSON.stringify(lines)}`,
    );
    assert.equal(
      lines.some((line) => line.includes("https://x.com/target")),
      false,
      `a link target is chrome and must stay hidden; lines were ${JSON.stringify(lines)}`,
    );
    assert.ok(
      lines.some((line) => line.includes("https://x.com/bare")),
      `a bare URL is not a link target and must stay visible; lines were ${JSON.stringify(lines)}`,
    );
    assert.equal(await value(), source, "the source buffer must be untouched by rendering");
    await page.evaluate((text) => window.__testEditor.setValue(text, { resetHistory: true, silent: true }), ctx.fixture);
    await caretToStart(page);
  });
}
