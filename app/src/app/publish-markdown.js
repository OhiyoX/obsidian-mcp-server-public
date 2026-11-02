import { parseFrontmatter, stringifyMatter } from "../frontmatter.js";

const CONTROL_PROPERTY = "publish_properties";
const DEFAULT_PUBLIC_PROPERTIES = new Set([
  "title",
  "description",
  "tags",
  "aliases",
  "type",
  "status",
  "created",
  "updated",
  "date",
]);

function propertyName(value) {
  return String(value || "").trim().toLowerCase();
}

export function selectPublicProperties(data = {}) {
  const allowed = new Set(DEFAULT_PUBLIC_PROPERTIES);
  const control = Object.entries(data).find(([key]) => propertyName(key) === CONTROL_PROPERTY)?.[1];
  if (Array.isArray(control)) {
    for (const value of control) {
      const name = propertyName(value);
      if (name && name !== CONTROL_PROPERTY) allowed.add(name);
    }
  }

  const selected = {};
  for (const [key, value] of Object.entries(data || {})) {
    const name = propertyName(key);
    if (name === CONTROL_PROPERTY || !allowed.has(name)) continue;
    selected[key] = value;
  }
  return selected;
}

export function sanitizePublicMarkdownBody(raw) {
  return String(raw || "")
    .replace(/!\[\[[^\]\r\n]+]]/g, "附件未公开")
    .replace(/!\[([^\]]*)]\([^\r\n)]*\)/g, (_match, alt) => alt ? `${alt}（附件未公开）` : "附件未公开")
    .replace(/\[\[([^\]|\r\n]+)(?:\|([^\]\r\n]+))?]]/g, (_match, target, label) => label || target.replace(/^.*\//, "").replace(/#.*/, ""));
}

export function publicPublishMarkdown(raw) {
  const parsed = parseFrontmatter(String(raw || ""));
  const body = sanitizePublicMarkdownBody(parsed.content);
  const properties = selectPublicProperties(parsed.data);
  return Object.keys(properties).length ? stringifyMatter(properties, body) : body;
}
