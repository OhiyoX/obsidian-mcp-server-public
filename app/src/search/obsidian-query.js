const FIELD_TYPES = new Set(["path", "file", "tag", "content", "line", "section"]);

function queryError(message, offset) {
  const error = new Error(`${message} at position ${offset + 1}`);
  error.code = "INVALID_SEARCH_QUERY";
  return error;
}

function tokenize(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    while (/\s/u.test(source[index] || "")) index += 1;
    if (index >= source.length) break;
    const start = index;
    let value = "";
    let quoted = false;
    let bracketDepth = 0;
    let parenDepth = 0;
    while (index < source.length) {
      const char = source[index];
      if (char === '"') {
        quoted = !quoted;
        value += char;
        index += 1;
        continue;
      }
      if (!quoted && char === "[" && value.replace(/^-/, "") === "") bracketDepth += 1;
      if (!quoted && char === "]" && bracketDepth) bracketDepth -= 1;
      if (!quoted && char === "(" && (parenDepth || /^[^-][\p{L}-]+:$/u.test(value.replace(/^-/, "")))) parenDepth += 1;
      if (!quoted && char === ")" && parenDepth) parenDepth -= 1;
      if (!quoted && !bracketDepth && !parenDepth && /\s/u.test(char)) break;
      value += char;
      index += 1;
      if (!quoted && bracketDepth === 0 && value.replace(/^-/, "").startsWith("[") && char === "]") break;
    }
    if (quoted) throw queryError("Unterminated quoted phrase", start);
    if (bracketDepth) throw queryError("Unterminated property filter", start);
    if (parenDepth) throw queryError("Unterminated grouped filter", start);
    tokens.push({ value, offset: start });
  }
  return tokens;
}

function splitOutsideQuotes(value, separator) {
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '"') quoted = !quoted;
    else if (!quoted && value[index] === separator) return [value.slice(0, index), value.slice(index + 1)];
  }
  return [value];
}

function cleanValue(value, offset) {
  const trimmed = String(value || "").trim();
  if (!trimmed) throw queryError("Search operator requires a value", offset);
  if (trimmed.startsWith('"') || trimmed.endsWith('"')) {
    if (!(trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)) throw queryError("Invalid quoted phrase", offset);
    return trimmed.slice(1, -1);
  }
  return trimmed.replaceAll('"', "");
}

function fieldValues(value, offset) {
  const trimmed = String(value || "").trim();
  if (!(trimmed.startsWith("(") || trimmed.endsWith(")"))) return [cleanValue(trimmed, offset)];
  if (!(trimmed.startsWith("(") && trimmed.endsWith(")"))) throw queryError("Invalid grouped filter", offset);
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) throw queryError("Grouped filter requires a value", offset);
  const values = tokenize(inner).map((token) => cleanValue(token.value, offset + 1 + token.offset));
  if (values.includes("OR")) throw queryError("OR is not supported inside a field group", offset);
  return values;
}

function parseClause(token) {
  let raw = token.value;
  const negated = raw.startsWith("-") && raw.length > 1;
  if (negated) raw = raw.slice(1);
  if (raw.startsWith("[")) {
    if (!raw.endsWith("]")) throw queryError("Invalid property filter", token.offset);
    const [name, propertyValue] = splitOutsideQuotes(raw.slice(1, -1), ":");
    const key = cleanValue(name, token.offset);
    return {
      type: "property",
      key,
      value: propertyValue === undefined ? null : cleanValue(propertyValue, token.offset + name.length + 1),
      negated,
      raw: token.value,
    };
  }
  const [candidate, fieldValue] = splitOutsideQuotes(raw, ":");
  const normalizedField = candidate.toLocaleLowerCase();
  if (fieldValue !== undefined && FIELD_TYPES.has(normalizedField)) {
    const values = fieldValues(fieldValue, token.offset + candidate.length + 1);
    return { type: normalizedField, value: values.join(" "), values, negated, raw: token.value };
  }
  return { type: "text", value: cleanValue(raw, token.offset), negated, raw: token.value };
}

export function parseObsidianQuery(input) {
  const source = String(input || "").trim();
  if (!source) return { source, groups: [], clauses: [], semanticText: "" };
  const groups = [[]];
  for (const token of tokenize(source)) {
    if (token.value === "OR") {
      if (!groups.at(-1).length) throw queryError("OR requires a term before it", token.offset);
      groups.push([]);
      continue;
    }
    groups.at(-1).push(parseClause(token));
  }
  if (!groups.at(-1).length) throw queryError("OR requires a term after it", source.length - 1);
  const clauses = groups.flat();
  const semanticText = clauses
    .filter((clause) => !clause.negated && ["text", "content", "line", "section"].includes(clause.type))
    .flatMap((clause) => clause.values || [clause.value])
    .join(" ")
    .trim();
  return { source, groups, clauses, semanticText };
}

export function hasObsidianOperators(parsed) {
  return parsed.clauses.some((clause) => clause.type !== "text" || clause.negated) || parsed.groups.length > 1;
}
