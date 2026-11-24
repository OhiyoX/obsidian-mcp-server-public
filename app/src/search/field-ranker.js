import { projectLexicalFields } from "../vault-runtime/vault-index-runtime.js";
export { projectLexicalFields };

// S3 weights are selected offline on the frozen S1 qrels, never at query time.
export const LEXICAL_WEIGHTS = Object.freeze({ title: 2, alias: 2, path: 2, heading: 2, body: 1, b: 1, k1: 0.6 });
const FIELDS = ["title", "alias", "path", "heading", "body"];
const normalize = (value) => String(value ?? "").normalize("NFKC").toLowerCase();
const comparePath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

export function lexicalFieldStats(records) {
  const averages = Object.fromEntries(FIELDS.map((field) => [field, 0]));
  for (const record of records) {
    const fields = record.lexicalFields ?? projectLexicalFields(record);
    for (const field of FIELDS) averages[field] += fields[field].length / Math.max(1, records.length);
  }
  return { averages };
}

function occurrences(text, term) {
  let count = 0;
  for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + term.length)) count += 1;
  return count;
}

export function rankLexicalCandidates(queryPlan, candidates, fieldStats, weights = LEXICAL_WEIGHTS) {
  // The evaluator owns eligibility. In particular, phrases and all structural clauses
  // remain filters; they never contribute frequency or field weight.
  const terms = [];
  for (const clause of (queryPlan?.groups || []).flat()) {
    if (clause.negated || !["text", "content", "line", "section"].includes(clause.type)
      || String(clause.raw ?? "").includes('"')) continue;
    const fields = clause.type !== "text" ? ["heading", "body"]
      : queryPlan.includeFrontmatter === false ? ["path", "heading", "body"] : FIELDS;
    for (const value of clause.values || [clause.value]) {
      const text = normalize(value);
      if (text && !terms.some((term) => term.text === text && term.fields.join() === fields.join())) terms.push({ text, fields });
    }
  }
  const rows = candidates.map((record) => ({ record, fields: record.lexicalFields ?? projectLexicalFields(record) }));
  const df = new Map(terms.map((term) => [term, rows.filter(({ fields }) => term.fields.some((field) => fields[field].normalized.includes(term.text))).length]));
  return rows.map(({ record, fields }) => {
    let score = 0;
    let best = 0;
    let topSnippetRef = null;
    const reasons = [];
    for (const term of terms) {
      let frequency = 0;
      for (const field of term.fields) {
        const value = fields[field];
        const tf = occurrences(value.normalized, term.text);
        if (!tf) continue;
        const average = fieldStats?.averages?.[field] || 1;
        const contribution = weights[field] * tf / (1 - weights.b + weights.b * Math.max(1, value.length) / average);
        frequency += contribution;
        if (!reasons.includes(`field:${field}`)) reasons.push(`field:${field}`);
        if (contribution > best) {
          best = contribution;
          const at = value.normalized.indexOf(term.text);
          topSnippetRef = { field, text: value.text.slice(Math.max(0, at - 80), at + term.text.length + 80).trim() };
        }
      }
      const idf = Math.log(1 + (rows.length - df.get(term) + 0.5) / (df.get(term) + 0.5));
      score += idf * frequency * (weights.k1 + 1) / (weights.k1 + frequency);
    }
    return { path: record.path, score, reasons, topSnippetRef };
  }).sort((a, b) => b.score - a.score || comparePath(a, b));
}
