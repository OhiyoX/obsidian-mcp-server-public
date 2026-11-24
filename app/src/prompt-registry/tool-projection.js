// Per-request projection of tool descriptions.
//
// `tools/list` must show the text of the revision the request pinned, while tool
// membership, schemas, annotations and order stay exactly what the SDK registered.
// Only the `description` string is rebuilt, from the Base/Override pack plus the
// memory guidance suffix, so a published description reaches an open session on its
// next list without re-registering anything.

import { GUIDANCE_READ_TOOLS, GUIDANCE_WRITE_TOOLS, projectToolDescription } from "../memory-guidance.js";

const KNOWN = new Set([...GUIDANCE_READ_TOOLS, ...GUIDANCE_WRITE_TOOLS]);

/**
 * Return copies of `tools` whose descriptions come from `snapshot`.
 * A tool with no Base copy keeps the description it was registered with.
 */
export function projectNativeToolDescriptions(tools, snapshot) {
  if (!Array.isArray(tools) || snapshot === null || typeof snapshot?.values !== "object") return tools;
  return tools.map((tool) => {
    if (tool === null || typeof tool !== "object" || typeof tool.name !== "string") return tool;
    const projected = projectToolDescription(tool.name, snapshot);
    if (projected === undefined || projected === tool.description) return tool;
    return { ...tool, description: projected };
  });
}

export const PROJECTED_TOOL_NAMES = Object.freeze([...KNOWN]);
