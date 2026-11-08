import type { ChatMessageRecord } from "../../../src/ipc/bridgeContract";

export function chatListMessage(index: number, sparse = false): ChatMessageRecord {
  const person = Math.abs(Math.floor(index / 3) % 4);
  return {
    presentation: { group: `person-${person}`, hue: null, self: false },
    id: `m-${index}`,
    threadId: "conversation",
    authorKind: "human",
    authorDisplayName: `Person ${person}`,
    createdAtMs: 1_700_000_000_000 + index * 60_000,
    body: `Message ${index}. ` + (sparse
      ? index % 100 === 0 ? `See @[notes/plan-${index}.md].` : "Plain text."
      : "A varied length conversation for scrolling and reading. ".repeat(1 + Math.abs(index % 4))),
  };
}

// Longer than the main thread's parse limit, so it shows as plain text first
// and reflows when the worker's answer arrives.
export function chatListMarkdown(index: number): string {
  return [
    `## Reply ${index}`,
    "Here is the plan, with **bold** steps and `inline code`.",
    ...Array.from({ length: 12 }, (_, step) => `- Step ${step + 1}: check the *list* item and continue.`),
    "```ts",
    ...Array.from({ length: 12 }, (_, line) => `const value${line} = compute(${line});`),
    "```",
    "> A quoted note about the result.",
    "Closing paragraph. ".repeat(20),
  ].join("\n");
}
