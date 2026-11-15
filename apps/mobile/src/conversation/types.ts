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
  readonly reactions?: readonly {
    readonly emoji: string;
    readonly count: number;
    readonly mine?: boolean;
  }[];
  readonly replies?: {
    readonly count: number;
    readonly last: string;
    readonly people: readonly Author[];
  };
  readonly question?: { readonly options: readonly string[]; readonly chosen?: string };
  readonly working?: string;
  /** Only this phone has it, in its outbox: its state shows where the time would. */
  readonly local?: LocalMark;
}
