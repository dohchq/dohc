import type { ReportedAgent } from "../chats/agentCard";
import type { IdentityHue } from "../theme";

// Sample conversation for design review only. Real messages come from the server's chat operations.
export interface Author {
  readonly id: string;
  readonly name: string;
  readonly kind: "person" | "agent";
  /** People only: initials and colour. */
  readonly initials?: string;
  readonly hue?: string;
  /** Agents only: a connected agent, one dohc does not start, which shows the plug in place of the sparkle. */
  readonly connected?: boolean;
  /** Agents only: the agent's chosen identity colour; none takes the agent olive. */
  readonly agentHue?: IdentityHue;
  /** Your own agents only: the owner's display name, when it could be read. */
  readonly owner?: string;
  /** Connected agents only: what the agent's client reported about itself. */
  readonly reported?: ReportedAgent;
}

export type Segment = { readonly text: string } | { readonly mention: string; readonly agent?: boolean };

export interface Message {
  readonly id: string;
  /** The thread a post's replies open, for a message read from the server. */
  readonly threadId?: string;
  readonly author: Author;
  readonly at: string;
  /** Minutes since the conversation's first message, for grouping. */
  readonly minute: number;
  readonly body: readonly Segment[];
  readonly reactions?: readonly { readonly emoji: string; readonly count: number; readonly mine?: boolean }[];
  readonly replies?: { readonly count: number; readonly last: string; readonly people: readonly Author[] };
  readonly question?: { readonly options: readonly string[]; readonly chosen?: string };
  readonly working?: string;
}

const maya: Author = { id: "maya", name: "Maya Chen", kind: "person", initials: "MC", hue: "#b4583e" };
const sam: Author = { id: "sam", name: "Sam Ortiz", kind: "person", initials: "SO", hue: "#4f6aa8" };
const me: Author = { id: "me", name: "You", kind: "person", initials: "IV", hue: "#3f7f86" };
const nova: Author = { id: "nova", name: "Nova", kind: "agent", owner: "Ice" };
const scout: Author = { id: "scout", name: "Scout", kind: "agent", connected: true, agentHue: "amber",
  reported: { product: "Claude Code", version: "2.1", model: "Claude Opus 5.5" } };

export const sampleConversation = { name: "planning", members: 6 };

export const sampleMessages: readonly Message[] = [
  { id: "m1", author: maya, at: "9:02", minute: 0, body: [{ text: "Booked the flat in Alfama 🎉 Check-in is from 3pm on the 12th." }],
    reactions: [{ emoji: "🙌", count: 3, mine: true }, { emoji: "🏠", count: 1 }] },
  { id: "m2", author: maya, at: "9:03", minute: 1, body: [{ text: "It has a terrace, so dinners at home are an option." }] },
  { id: "m3", author: sam, at: "9:20", minute: 18, body: [{ text: "Nice. Can someone look at trains from Porto on the 15th?" }] },
  { id: "m4", author: me, at: "9:24", minute: 22, body: [{ mention: "Nova", agent: true }, { text: " can you add the Porto day trip to the itinerary app and check train times?" }],
    replies: { count: 3, last: "9:31", people: [nova, sam] } },
  { id: "m5", author: nova, at: "9:31", minute: 29, body: [{ text: "The 8:09 Alfa Pendular gets you to Porto at 10:58. Which return should the itinerary use?" }],
    question: { options: ["17:52", "19:52", "21:07"], chosen: "19:52" } },
  { id: "m6", author: sam, at: "9:40", minute: 38, body: [{ text: "19:52 works for me, gives us dinner by the river." }],
    reactions: [{ emoji: "👍", count: 2 }] },
  { id: "m7", author: nova, at: "9:41", minute: 39, body: [], working: "Updating the itinerary app" },
];

// A direct chat with one agent shows only you and that agent.
const novaMessages: readonly Message[] = [
  { id: "n1", author: me, at: "8:40", minute: 0, body: [{ text: "Can you draft a packing list for the 12th to the 19th? It should be warm." }] },
  { id: "n2", author: nova, at: "8:42", minute: 2, body: [{ text: "Added packing-list.md with clothes, documents and the adapter Sam mentioned." }] },
];

const scoutMessages: readonly Message[] = [
  { id: "s1", author: me, at: "10:12", minute: 0, body: [{ text: "Can you check the flat's cancellation terms?" }] },
  { id: "s2", author: scout, at: "10:14", minute: 2, body: [{ text: "Free cancellation until Nov 5. After that, the first night is charged. I added this to budget.md under Lodging." }] },
  { id: "s3", author: me, at: "10:15", minute: 3, body: [{ text: "Thanks. Remind me on the 4th." }] },
];

/** The sample messages for a chat: the agents' direct chats have their own; every other chat shows #planning's. */
export function sampleMessagesFor(chatId: string): readonly Message[] {
  if (chatId === "a-nova") return novaMessages;
  if (chatId === "a-scout") return scoutMessages;
  return sampleMessages;
}

/** An agent in this sample, by its author id, for its card. */
export function sampleAgent(id: string): Author | undefined {
  return [nova, scout].find(agent => agent.id === id);
}
