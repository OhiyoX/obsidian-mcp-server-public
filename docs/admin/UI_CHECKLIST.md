# Admin UI fine-tuning checklist

Use this checklist with the prototype and the current renderer, not as permission to redesign a page. Start from fetched `origin/main`; record the tested commit and compare any production drift before deployment.

## Scope and design system

- [ ] State the user's task and the exact layout defect before editing.
- [ ] Preserve page order, preview sidebars, navigation and independent save flows unless explicitly requested otherwise.
- [ ] Read `docs/admin-ui-proto/README.md` and `src/1-head.html`; reuse shared classes, spacing tokens, typography and control sizes.
- [ ] Do not patch generated `proto-css.js` directly. New controls/panels start in the prototype.
- [ ] Check desktop and coarse-pointer sizing separately; a narrow mouse window is not automatically a touch device.

## Information and alignment

- [ ] A section title and its first field must not repeat the same visible label unnecessarily. Keep an accessible name when removing a duplicate.
- [ ] Show a Vault name once when its ID is identical; retain distinct IDs where they disambiguate names.
- [ ] Align labels, controls, help text and actions to their owning group's edges.
- [ ] Separate permissions, allowed Vaults, routing defaults and dangerous actions with clear semantic groups. Do not merge independent writes just to save space.
- [ ] Give adjacent status cards a shared gap container; check two or more cards, not only the one-card case.
- [ ] Verify disabled, missing, stale and read-only records remain understandable and actionable where appropriate.

## Space efficiency

- [ ] Inspect actual screenshots for empty bordered areas, excessive section margins, fixed-height short lists and short selects stretched across a drawer.
- [ ] Keep scalar fields reasonably bounded; leave descriptive text room to wrap.
- [ ] Let multi-selection lists use available width and wrap safely; avoid forcing unrelated short and tall sections to equal heights.
- [ ] Do not optimize only total form height. Check reading order, usable target sizes, multi-row data and the location of primary actions.
- [ ] No overflow is not proof of compactness. Compare the same populated drawer before/after; inspect unused space inside groups, consider wrapping short options into columns and pairing short fields with their own save action, and record content/group heights without removing useful sections.
- [ ] Preserve useful previews. If a preview is saved-only, test new, saved, dirty and failed-save states and explain the distinction accurately.

## Browser verification

- [ ] Use the real route and current assets. Capture and inspect screenshots after the change.
- [ ] Cover representative lists, new/edit drawers, empty and long data, multiple selected items, and multiple applied rules.
- [ ] At minimum check a desktop viewport and a narrow viewport; add actual touch emulation for coarse-pointer rules.
- [ ] Measure document/container overflow, control clipping, overlaps and relevant target sizes. Check drawer content as well as the document root.
- [ ] Open custom select menus near the viewport bottom and confirm labels, focus and keyboard selection remain usable.
- [ ] Exercise the changed write through the real form, then read back the saved value. Check relevant no-script fallbacks.
- [ ] Read console/resource errors. Run affected tests; preserve unrelated failures as explicit limitations.
- [ ] Obtain independent review of the raw diff and focused risk probes. Report what was read, run, disproved and left unverified under `audit:`.
- [ ] Distinguish local verification, committed, PR, deployed and production-verified. A screenshot of a local fixture proves no production state.

## Delivery

- [ ] Show the relevant screenshot, summarize concrete fixes and disclose remaining issues.
- [ ] Update the existing Obsidian project note with current status and read it back; keep dated execution logs out of this living checklist.
