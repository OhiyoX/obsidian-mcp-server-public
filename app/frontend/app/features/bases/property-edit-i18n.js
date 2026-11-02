// The property page's copy, kept OUT of the eager i18n catalogs on purpose.
//
// `src/i18n/messages/*` is bundled into `app.js` (and `publish.js`), i.e. it is paid for on the
// first screen whether or not any Bases menu is ever opened. This page only exists after the
// reader clicks a row's `›` (see `property-edit-lazy.js`), so its twelve strings ship with the
// on-demand chunk instead. Same two-locale discipline as the shared catalogs — both locales carry
// the same key set, asserted by `test/web-bases-property-edit-lazy.test.js` — just a smaller
// carrier for an asset that is not on the critical path.
export const PROPERTY_EDIT_MESSAGES = Object.freeze({
  "zh-CN": Object.freeze({
    "bases.property.edit": "编辑 {name}",
    "bases.property.displayName": "显示名称",
    "bases.property.type": "属性类型",
    "bases.property.saveFailed": "保存失败",
    "bases.property.precondition": "请求缺少前条件（revision），本次未写入；请重新载入 Base。",
    "bases.property.staleAdopted": "Base 已在别处被修改，已取回最新 revision，请再次提交。",
    "bases.property.staleLost": "Base 已在别处被修改，且未取回最新 revision，请关闭后重新打开此页再试。",
    "bases.property.typeReadOnly": "只读（类型写面未证实）",
    "bases.property.typeUnverified": "类型来自仓库级类型表，本服务暂无写面（未证实）",
    "bases.property.typeText": "文本",
    "bases.property.typeNumber": "数字",
    "bases.property.typeDate": "日期",
    "bases.property.typeDatetime": "日期 & 时间",
    "bases.property.typeCheckbox": "复选框",
    "bases.property.typeList": "列表",
    "bases.property.typeTags": "标签",
  }),
  en: Object.freeze({
    "bases.property.edit": "Edit {name}",
    "bases.property.displayName": "Display name",
    "bases.property.type": "Property type",
    "bases.property.saveFailed": "Could not save",
    "bases.property.precondition": "The request carried no revision, so nothing was written. Reload the Base.",
    "bases.property.staleAdopted": "The Base changed elsewhere; the latest revision was fetched — submit again.",
    "bases.property.staleLost": "The Base changed elsewhere and the latest revision could not be fetched; reopen this page and try again.",
    "bases.property.typeReadOnly": "Read-only (no verified type write face)",
    "bases.property.typeUnverified": "The type comes from the vault-level type table; this service has no write face for it yet (unverified)",
    "bases.property.typeText": "Text",
    "bases.property.typeNumber": "Number",
    "bases.property.typeDate": "Date",
    "bases.property.typeDatetime": "Date & time",
    "bases.property.typeCheckbox": "Checkbox",
    "bases.property.typeList": "List",
    "bases.property.typeTags": "Tags",
  }),
});

/** The page's translator: `<html lang>` decides, like `core/i18n.js` does for the shell. */
export function propertyEditTranslator(doc) {
  const tag = String(doc?.documentElement?.getAttribute?.("lang") || "").toLowerCase();
  const catalog = PROPERTY_EDIT_MESSAGES[tag.startsWith("en") ? "en" : "zh-CN"];
  return (key, params) => {
    const template = catalog[key];
    if (template === undefined) return String(key);
    return params
      ? template.replace(/\{(\w+)\}/g, (whole, name) => (params[name] === undefined || params[name] === null ? whole : String(params[name])))
      : template;
  };
}
