import { z } from "zod/v4";

export function registerPrompts(server) {
  if (typeof server.registerPrompt !== "function") return;
  server.registerPrompt(
    "research_brief",
    {
      title: "Obsidian Research Brief",
      description: "Search, read, and synthesize vault notes with citations to note paths.",
      argsSchema: { topic: z.string().describe("Research topic to investigate in the Obsidian vault") },
    },
    ({ topic }) => ({
      messages: [
        {
          role: "user",
          content: { type: "text", text: `Search the Obsidian vault for "${topic}", read the most relevant notes, and produce a concise brief with citations to vault-relative note paths.` },
        },
      ],
    }),
  );
}
