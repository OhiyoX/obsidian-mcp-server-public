// Capability catalogue for the AuthZ editor — the *runtime's* groups (surface / scope / toolset /
// tool / resource), not the prototype's mock list, with Chinese labels for the ones the runtime
// names in English. Names are presentation only; the value sent to the service is always the raw
// capability key, and an unknown key keeps its raw form on screen.
import { TOOL_NAMES } from "../config.js";
import { MCP_RESOURCE_SCOPE_REQUIREMENTS, MCP_SCOPES } from "../scopes.js";
import { TOOLSET_TOOLS } from "../capability-catalog.js";
import { CAP_GROUP_LABEL, CAP_GROUP_ORDER, scopeName } from "./presentation/vocab.js";

const TOOLSET_LABELS = Object.freeze({
  info: "服务信息",
  notes: "笔记",
  search: "检索",
  files: "文件",
  links: "链接",
  workflows: "工作流",
  git: "Git",
  intelligence: "智能",
  context: "上下文",
  publish: "发布",
  plans: "计划",
});

const SURFACE_LABELS = Object.freeze({ mcp: "MCP", web: "Web", oauth: "OAuth" });

function humanKey(key) {
  const cut = key.indexOf(":");
  const group = cut < 0 ? "all" : key.slice(0, cut);
  const value = cut < 0 ? key : key.slice(cut + 1);
  if (group === "all") return "全部能力";
  if (group === "scope") return scopeName(value);
  if (group === "toolset") return TOOLSET_LABELS[value] || value;
  if (group === "surface") return SURFACE_LABELS[value] || value;
  if (group === "resource") return value;
  return value;
}

let cached = null;

/** Frozen groups: `[{ group, label, items: [{ key, name }] }]` in the prototype's display order. */
export function capabilityCatalog() {
  if (cached) return cached;
  const groups = [
    { group: "all", items: ["all"] },
    { group: "surface", items: ["surface:mcp", "surface:web", "surface:oauth"] },
    { group: "scope", items: MCP_SCOPES.map((scope) => `scope:${scope}`) },
    { group: "toolset", items: Object.keys(TOOLSET_TOOLS).map((toolset) => `toolset:${toolset}`) },
    { group: "tool", items: [...TOOL_NAMES].map((tool) => `tool:${tool}`) },
    { group: "resource", items: Object.keys(MCP_RESOURCE_SCOPE_REQUIREMENTS).map((uri) => `resource:${uri}`) },
  ];
  const nameByKey = new Map();
  const built = CAP_GROUP_ORDER.map((group) => {
    const found = groups.find((item) => item.group === group);
    const items = (found?.items || []).map((key) => {
      const name = humanKey(key);
      nameByKey.set(key, name);
      return Object.freeze({ key, name });
    });
    return Object.freeze({ group, label: CAP_GROUP_LABEL[group] || group, items: Object.freeze(items) });
  });
  cached = Object.freeze({
    groups: Object.freeze(built),
    keys: Object.freeze([...nameByKey.keys()]),
    nameOf: (key) => nameByKey.get(String(key)) || String(key ?? ""),
    isValid: (key) => nameByKey.has(String(key)),
  });
  return cached;
}
