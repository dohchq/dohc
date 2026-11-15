import type { ReportedAgent } from "../chats/agentCard";
import type { IdentityHue } from "../theme";

// A conversation's messages as the phone draws them, from the server's reads, this phone's outbox, or the sample.

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

export type Segment =
  | { readonly text: string }
  | { readonly mention: string; readonly agent?: boolean };

/**
 * Where a message only this phone has stands, from its outbox record. `waiting`: never sent. `sending`: a request may
 * have reached the server. `stalled`: the server has answered pending for a long time. `saved`: the server has it, and
 * a read doesn't show it yet. `withheld`: kept on the phone, and nothing sends it until Send. `refused` and `missing`
 * are settled without the message, and say why.
 */
export type LocalState =
  | { readonly kind: "waiting" | "sending" | "stalled" | "saved" | "withheld" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "missing" };

export interface LocalMark {
  /** The outbox record's operation, which Send and Discard act on. */
  readonly operationId: string;
  readonly state: LocalState;
  /** A request may have reached the server, so Discard warns that it may still send. */
  readonly attempted: boolean;
  /** The text as the outbox keeps it, which Send sends and Copy copies. */
  readonly body: string;
}

/** One emoji's reactions to a message. */
export interface Reaction {
  readonly emoji: string;
  readonly count: number;
  /** The account's own is among them, as the server has it or as this phone's latest reaction says. */
  readonly mine?: boolean;
  /** This phone's reaction with this emoji isn't settled yet. */
  readonly pending?: boolean;
}

/**
 * A reaction of this phone's that needs the person: withheld, still sending, refused, for a message the server can't
 * find, or saved but shown otherwise by a read since.
 */
export interface ReactionMark {
  readonly emoji: string;
  /** The state the reaction asks for. */
  readonly state: "added" | "removed";
  readonly mark: LocalMark;
}

/**
 * Where a message's question or poll stands. `open`: it takes an answer. `held`: this phone keeps an answer withheld,
 * which its reply's Send or Discard settles, so it takes no other. `answering`: this phone's answer is on its way.
 * `answered`: the server, or this phone's saved answer, says it's answered. `lost`: the server took another answer
 * first; `winner` is that answer when a read shows it, and `replySent` says a read shows this phone's reply.
 * `chosen` is the poll's choice that state shows, or null.
 */
export type DecisionState =
  | { readonly kind: "open" | "held" }
  | { readonly kind: "answering" | "answered"; readonly chosen: string | null }
  | {
      readonly kind: "lost";
      readonly chosen: string | null;
      readonly winner: { readonly name: string; readonly body: string } | null;
      readonly replySent: boolean;
    };

export interface Decision {
  /** A poll's choices, in its author's own words. A question has none. */
  readonly options: readonly string[];
  readonly state: DecisionState;
}

export interface Message {
  readonly id: string;
  readonly threadId?: string;
  readonly author: Author;
  readonly at: string;
  /** Minutes since the epoch, or since a sample conversation's first message, for grouping. */
  readonly minute: number;
  /** A post's title, drawn above its body. */
  readonly title?: string;
  readonly body: readonly Segment[];
  readonly reactions?: readonly Reaction[];
  readonly reactionMarks?: readonly ReactionMark[];
  /** A reaction of this phone's to the message isn't settled, so its reaction controls wait. */
  readonly reactionsBusy?: boolean;
  readonly replies?: {
    readonly count: number;
    readonly last: string;
    readonly people: readonly Author[];
  };
  /** The question or poll it asks, with this phone's answer over the server's state. */
  readonly decision?: Decision;
  readonly working?: string;
  /** Only this phone has it, in its outbox: its state shows where the time would. */
  readonly local?: LocalMark;
  /**
   * Only this phone has it, and it's a post or send a reply can wait for: the outbox's record, the message the write
   * makes, and the thread the server named once it saved it.
   */
  readonly replyable?: {
    readonly operationId: string;
    readonly messageId: string;
    readonly threadId: string | null;
  };
}
