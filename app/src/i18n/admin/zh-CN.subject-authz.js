// Admin plane — 主体侧栏的定时授权（2026-10-31；2026-11-09 迁到按 Vault 的约束，只读）— Simplified Chinese copy.
export default Object.freeze({
  "adm.subjectAuthz.title": "定时授权",
  "adm.subjectAuthz.help": "只在这个主体已有的权限上再加限制，不会放大权限；管理后台本身不受约束。",
  "adm.subjectAuthz.unrestricted": "不受定时授权限制 · 没有约束引用这个主体，按原有权限访问",
  "adm.subjectAuthz.stateAllowed": "此刻允许",
  "adm.subjectAuthz.stateRestricted": "此刻受限",
  "adm.subjectAuthz.stateDisabled": "已停用",
  "adm.subjectAuthz.view": "查看",
  "adm.subjectAuthz.frozen": "只读：要把这个主体加进某条约束，请到 {href} 配置 —— 这里只列出引用它的约束。",
  "adm.subjectAuthz.unavailable": "约束存储暂时不可用：读不到文档，所以这里说不清哪些约束引用了这个主体。",
});
