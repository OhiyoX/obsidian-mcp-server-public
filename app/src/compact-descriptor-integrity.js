// Compact descriptor integrity and schema fingerprint (Issue #626).
//
// A Host caches the `tools/list` schema it received. The compact profile
// synthesizes its descriptors from the live native catalog, so a *stale Host
// snapshot* and a *real server-side mapping defect* are indistinguishable from
// the wire alone: the caller just sees an `action.enum` that is missing a
// value. This module makes both states machine-decidable without widening any
// schema:
//
//   * `checkCompactDescriptorIntegrity` proves the descriptor <-> group
//     membership equation in both directions (branch count, branch set,
//     `action.enum`, routed-action uniqueness) and names every violation.
//   * `compactDescriptorFingerprint` gives one build a stable 16-hex digest of
//     the normalized descriptor set, so any Host can reconcile "the schema I
//     cached" against "the schema this server currently serves".
//
// This module only reads. It grants, hides, and executes nothing.

import { createHash } from "node:crypto";
import { COMPACT_GROUPS, COMPACT_PASSTHROUGH } from "./compact-tools.js";

const PASSTHROUGH = new Set(COMPACT_PASSTHROUGH);

// Order-insensitive object rendering, order-preserving for arrays: the `oneOf`
// branch order is part of the descriptor, the JSON key order is not.
export function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort()
      .map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key]))
      .join(",") + "}";
  }
  return value === undefined ? "null" : JSON.stringify(value);
}

/** Stable 16-hex digest of a descriptor list, normalized for key order. */
export function compactDescriptorFingerprint(tools) {
  return createHash("sha256").update(canonicalJson(tools)).digest("hex").slice(0, 16);
}

/** Actions reachable through a descriptor list: one per `oneOf` branch, or the
 * native name for a passthrough descriptor. */
export function compactDescriptorBranchTotal(tools) {
  return tools.reduce((total, tool) => {
    const branches = tool?.inputSchema?.oneOf;
    return total + (Array.isArray(branches) ? branches.length : 1);
  }, 0);
}

function memberDomains(groups) {
  const map = new Map();
  for (const [domain, names] of Object.entries(groups)) {
    for (const name of names) map.set(name, domain);
  }
  return map;
}

function domainFor(descriptorName, domains, memberToDomain) {
  // A passthrough descriptor keeps its native name, which is not always
  // prefixed by its group domain (`server_info` lives in `obsidian_info`).
  const declared = memberToDomain.get(descriptorName);
  if (declared) return declared;
  let match = null;
  for (const domain of domains) {
    if (descriptorName === domain || descriptorName.startsWith(domain + "_")) {
      if (!match || domain.length > match.length) match = domain;
    }
  }
  return match;
}

/**
 * Verify one compact descriptor list against the group mapping that produced it.
 *
 * `routing` is the Map returned by `compactToolView`; `groups` defaults to the
 * shipped mapping and is an argument so a test can inject a drifted mapping.
 * Every violation is reported as a name-carrying string, and each domain gets an
 * explicit `groupMembers` vs `exposedActions` reading.
 */
export function checkCompactDescriptorIntegrity({ tools, routing, groups = COMPACT_GROUPS } = {}) {
  if (!Array.isArray(tools)) throw new TypeError("checkCompactDescriptorIntegrity requires a tools[] array");
  if (!(routing instanceof Map)) throw new TypeError("checkCompactDescriptorIntegrity requires the compactToolView routing Map");

  const errors = [];
  const equations = [];
  const domains = Object.keys(groups);
  const memberToDomain = memberDomains(groups);
  const exposedByDomain = new Map(domains.map((domain) => [domain, []]));
  const descriptorsByDomain = new Map(domains.map((domain) => [domain, []]));
  const seen = new Set();

  for (const tool of tools) {
    const name = tool?.name;
    if (typeof name !== "string" || !name) {
      errors.push("descriptor without a usable name");
      continue;
    }
    if (seen.has(name)) errors.push(`duplicate descriptor name: ${name}`);
    seen.add(name);

    const routed = routing.get(name);
    if (!(routed instanceof Set)) {
      errors.push(`descriptor ${name} has no routing entry`);
      continue;
    }

    const branches = tool.inputSchema?.oneOf;
    if (Array.isArray(branches)) {
      const consts = branches.map((branch) => branch?.properties?.action?.const);
      for (const [index, value] of consts.entries()) {
        if (typeof value !== "string" || !value) errors.push(`descriptor ${name}: oneOf branch #${index} has no properties.action.const`);
      }
      const branchSet = new Set(consts.filter((value) => typeof value === "string" && value));
      if (branchSet.size !== consts.length) errors.push(`descriptor ${name}: duplicate oneOf branches`);
      if (branches.length !== routed.size) {
        errors.push(`descriptor ${name}: oneOf branches=${branches.length} but routed members=${routed.size}`);
      }
      for (const value of branchSet) {
        if (!routed.has(value)) errors.push(`descriptor ${name}: oneOf branch ${value} is not a routed member`);
      }
      for (const member of routed) {
        if (!branchSet.has(member)) errors.push(`descriptor ${name}: routed member ${member} has no oneOf branch`);
      }

      const enumValues = tool.inputSchema?.properties?.action?.enum;
      if (!Array.isArray(enumValues)) {
        errors.push(`descriptor ${name}: properties.action.enum is missing`);
      } else {
        const enumSet = new Set(enumValues);
        if (enumSet.size !== enumValues.length) errors.push(`descriptor ${name}: duplicate action.enum values`);
        for (const value of enumSet) {
          if (!branchSet.has(value)) errors.push(`descriptor ${name}: action.enum value ${value} has no oneOf branch`);
        }
        for (const value of branchSet) {
          if (!enumSet.has(value)) errors.push(`descriptor ${name}: oneOf branch ${value} is missing from action.enum`);
        }
      }
    } else {
      // Native passthrough descriptors keep their own name and schema.
      if (routed.size !== 1 || !routed.has(name)) errors.push(`passthrough descriptor ${name} must route to exactly itself`);
      if (!PASSTHROUGH.has(name)) errors.push(`descriptor ${name} has no oneOf and is not a declared passthrough name`);
    }

    const domain = domainFor(name, domains, memberToDomain);
    if (!domain) {
      errors.push(`descriptor ${name} belongs to no group domain`);
      continue;
    }
    descriptorsByDomain.get(domain).push(name);
    for (const member of routed) exposedByDomain.get(domain).push(member);
  }

  const counts = new Map();
  for (const bucket of exposedByDomain.values()) {
    for (const name of bucket) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const [name, count] of counts) {
    if (count > 1) errors.push(`action ${name} is exposed by ${count} descriptors`);
  }

  for (const domain of domains) {
    const expected = [...groups[domain]].sort();
    const actual = [...exposedByDomain.get(domain)].sort();
    const ok = expected.length === actual.length && expected.every((value, index) => value === actual[index]);
    equations.push(Object.freeze({
      domain,
      descriptors: Object.freeze([...descriptorsByDomain.get(domain)]),
      groupMembers: expected.length,
      exposedActions: actual.length,
      ok,
    }));
    if (!ok) {
      const missing = expected.filter((value) => !actual.includes(value));
      const unexpected = actual.filter((value) => !expected.includes(value));
      errors.push(`group ${domain}: members=${expected.length} exposedActions=${actual.length} missing=[${missing.join(", ")}] unexpected=[${unexpected.join(", ")}]`);
    }
  }

  const exposedTotal = [...exposedByDomain.values()].reduce((total, bucket) => total + bucket.length, 0);
  const memberTotal = domains.reduce((total, domain) => total + groups[domain].length, 0);
  if (exposedTotal !== memberTotal) errors.push(`exposed action total=${exposedTotal} but group membership total=${memberTotal}`);

  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors),
    equations: Object.freeze(equations),
    exposedTotal,
    memberTotal,
  });
}
