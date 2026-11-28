import type { IdentityHue } from "../theme";

// The chat list as Chats draws it, from the server's reads or the sample.
export type ChatKind = "group" | "person" | "agent" | "comment";

export interface ChatRowData {
  readonly id: string;
  readonly kind: ChatKind;
  readonly name: string;
  readonly unread: boolean;
  /** Unread messages: ink when you were addressed (a direct message or your agent), quiet for a group you follow. */
  readonly count?: number;
  readonly muted?: boolean;
  readonly online?: boolean;
  /** Agents only: a connected agent, one dohc does not start, which shows the plug in place of the sparkle. */
  readonly connected?: boolean;
  /** Agents only: the agent's chosen identity colour; none takes the agent olive. */
  readonly agentHue?: IdentityHue;
  /** People only: initials and colour. */
  readonly initials?: string;
  readonly hue?: string;
}

export interface ChatSection {
  readonly key: string;
  readonly title: string;
  readonly rows: readonly ChatRowData[];
}

/** A workspace as the phone lists it, from the sample or the server. */
export interface PhoneWorkspace {
  readonly id: string;
  readonly name: string;
  readonly initial: string;
  readonly color: string;
  /** False for a server's workspace whose sync isn't set up yet, which the phone can't open. */
  readonly canOpen?: boolean;
  /** The account's role in a server's workspace. A sample workspace has none. */
  readonly role?: "owner" | "admin" | "member";
  /** Whether the server supports owner file lifecycle writes for this workspace. */
  readonly fileWritesAvailable?: boolean;
  readonly sections: readonly ChatSection[];
}
