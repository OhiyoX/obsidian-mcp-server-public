import yaml from "js-yaml";

/**
 * Parse a YAML frontmatter block that includes the opening/closing --- fences.
 * Returns null when the region is not a closed mapping frontmatter.
 */
export function parseFrontmatterBlock(source) {
  const text = String(source ?? "");
  const match = text.match(/^---\r?\n([\s\S]*?)^---(?:\r?\n|$)/m);
  if (!match || match.index !== 0) return null;
  try {
    const parsed = yaml.load(match[1]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return {
      properties: Object.entries(parsed),
      data: parsed,
      bodyStart: match[0].length,
      rawYaml: match[1],
    };
  } catch {
    return null;
  }
}

/** Serialize a plain object into a closed YAML frontmatter block ending with a newline. */
export function serializeFrontmatter(data) {
  const object = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const dumped = yaml.dump(object, {
    lineWidth: -1,
    noRefs: true,
    quotingType: '"',
    forceQuotes: false,
  }).replace(/\s+$/u, "");
  return dumped ? `---\n${dumped}\n---\n` : "---\n---\n";
}

export function isListPropertyKey(key) {
  return /^(?:tags?|aliases|cssclasses)$/i.test(key);
}

export function propertyIconName(key) {
  if (/^(?:tags?|aliases)$/i.test(key)) return "tag";
  if (/^(?:created|updated|date|modified)$/i.test(key)) return "calendar";
  if (/^mcp_author$/i.test(key)) return "circle-help";
  return "text";
}

export function coercePropertyInput(key, raw, previous) {
  const text = String(raw ?? "").trim();
  if (isListPropertyKey(key)) {
    return text
      ? text.split(/\s*,\s*/u).map((item) => item.trim()).filter(Boolean)
      : [];
  }
  if (typeof previous === "boolean") {
    if (/^(?:true|false)$/i.test(text)) return text.toLowerCase() === "true";
    return previous;
  }
  if (typeof previous === "number" && text !== "" && Number.isFinite(Number(text))) {
    return Number(text);
  }
  if (previous instanceof Date || Object.prototype.toString.call(previous) === "[object Date]") {
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? previous : date;
  }
  if (previous && typeof previous === "object") {
    try {
      return JSON.parse(text);
    } catch {
      return previous;
    }
  }
  if (text === "") return null;
  return text;
}

export function displayPropertyValue(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map((item) => (item == null ? "" : String(item))).join(", ");
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) {
    // The authored calendar day is a UTC day (js-yaml date-only = UTC midnight); local
    // components would show — and on blur re-store — the previous day in a UTC-x zone.
    const year = value.getUTCFullYear();
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    const day = String(value.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
