import { z } from "zod/v4";
import { bundledPromptRegistry } from "./prompt-registry/bundled.js";
import { livePromptSnapshot } from "./prompt-registry/live.js";
import { renderPromptTemplate } from "./prompt-registry/schema.js";

/** Prompt names the server exposes; their copy lives in the Base pack. */
export const MCP_PROMPT_NAMES = Object.freeze(["research_brief"]);

export function registerPrompts(server, { registry = null } = {}) {
  if (typeof server.registerPrompt !== "function") return;
  const snapshotOf = () => (registry === null ? livePromptSnapshot() : registry.snapshot());
  const values = snapshotOf().values;
  for (const name of MCP_PROMPT_NAMES) {
    server.registerPrompt(
      name,
      {
        title: values[`prompts.${name}.title`],
        description: values[`prompts.${name}.description`],
        argsSchema: { topic: z.string().describe("Research topic to investigate in the Obsidian vault") },
      },
      ({ topic }) => ({
        messages: [
          {
            role: "user",
            // Read per call: a publish reaches the next prompts/get in this session.
            content: { type: "text", text: renderPromptTemplate(snapshotOf().values[`prompts.${name}.body`], { topic }) },
          },
        ],
      }),
    );
  }
}
