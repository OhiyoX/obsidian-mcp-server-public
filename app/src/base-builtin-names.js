// Desktop built-in Base property display names (U5 closure).
//
// Desktop priority for a property label is exactly three steps —
// `getDisplayName()` at asar `app.js@2352471`:
//
//     this.displayName ? this.displayName
//                      : Object.hasOwn(o$, this.propertyId) ? o$[this.propertyId]()
//                      : UQ(this.propertyId).name
//
// i.e. the author's declared `properties.<key>.displayName` → the built-in name
// table `o$` → the property name itself, with **no branch on the property kind**.
// `o$` is at asar `app.js@2351488`: exactly 14 `file.*` keys, each value an i18n
// `label-file-prop-*` string. This module is that table, and it is the ONLY copy:
// `src/base-query.js` (the label for every consumer, Web and MCP alike) and
// `frontend/app/features/bases/panel-chrome.js` (the stale URL-override key, which
// by definition arrives without a server label) both import it, so the three
// surfaces cannot drift.
//
// Values are copied VERBATIM from the desktop's `i18n/zh.txt` at the line its key
// occupies in `i18n/mapping.txt` (the two files are line-aligned, 2601 lines each);
// both were read from the 1.14.4 extraction
// `<local-desktop-research>/extract/obsidian-asar-1.14.4/`. The trailing number
// beside each entry is that shared line number in BOTH files:
//
//   mapping.txt:2334-2347  `plugins.bases.label-file-prop-*`  ↔  zh.txt:2334-2347
//
// Key order is the desktop's `o$` order, not alphabetical: `links` (2345) precedes
// `backlinks` (2344). The keys are written out in full even though all 14 share the
// `file.` prefix: the shorter, prefix-factored form was built and measured worse after
// gzip, so it was rejected. The budget account for this cut (the one place the byte
// readings live) is `app/scripts/web-firstload-baseline.json` `notes[0]`.
//
// `编辑时间` is NOT here: that is the owner's own `displayName` value inside a
// `.base`, not a desktop built-in name, and mixing the two is what BRIEF-DELTA ruled
// out.
export const BASE_BUILTIN_PROPERTY_NAMES = Object.freeze({
  "file.file": "文件", // 2334
  "file.name": "名称", // 2335
  "file.basename": "文件名", // 2336
  "file.fullname": "完整文件名", // 2337
  "file.path": "路径", // 2338
  "file.folder": "文件夹", // 2339
  "file.ext": "扩展名", // 2340
  "file.ctime": "创建时间", // 2341
  "file.mtime": "修改时间", // 2342
  "file.size": "文件大小", // 2343
  "file.links": "文件链接", // 2345
  "file.backlinks": "文件反向链接", // 2344
  "file.embeds": "文件嵌入", // 2346
  "file.tags": "文件标签", // 2347
});

// Returns the desktop built-in display name for a key, or `null` when the key is not
// one of the 14 (`null`, not `undefined`, so a caller can chain `??`). The lookup is
// own-key only, so a custom property named after a tail (`mtime`, `tags`, `name`) is
// never translated, and `file.toString` cannot resolve through the prototype chain.
export function builtinPropertyName(key) {
  return Object.hasOwn(BASE_BUILTIN_PROPERTY_NAMES, key) ? BASE_BUILTIN_PROPERTY_NAMES[key] : null;
}
