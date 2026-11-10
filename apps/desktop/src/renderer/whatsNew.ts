import { Bot, ContactRound, History, Link } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface WhatsNewItem {
  icon: LucideIcon;
  title: string;
  body: string;
}

export interface WhatsNewRelease {
  // Unique and never reused: a new id opens the tab once after an update.
  id: string;
  title: string;
  items: readonly WhatsNewItem[];
}

// Newest first. Add a release here when an update brings something people
// should know about; updates without a new entry open nothing.
export const WHATS_NEW: readonly WhatsNewRelease[] = [
  {
    id: "2026-11",
    title: "November 2026",
    items: [
      {
        icon: Link,
        title: "Links to messages",
        body: "Copy a link to any chat message. Opening the link in dohc goes straight to that message.",
      },
      {
        icon: History,
        title: "Agent edits in History",
        body: "History names the connected agent that made each edit and marks it with a plug.",
      },
      {
        icon: Bot,
        title: "Agents on your share links",
        body: "See which agents joined through a share link, and disconnect any of them.",
      },
      {
        icon: ContactRound,
        title: "Group members",
        body: "Add and manage a group's members in one dialog.",
      },
    ],
  },
];

const SEEN_KEY = "dohc.whatsNew.seen";

// True once per new release. A first launch records the newest release
// without opening it, so a new install starts on the person's work.
export function takeUnseenWhatsNew(storage: Pick<Storage, "getItem" | "setItem"> = localStorage): boolean {
  const newest = WHATS_NEW[0]?.id;
  if (newest === undefined) return false;
  try {
    const seen = storage.getItem(SEEN_KEY);
    if (seen === newest) return false;
    storage.setItem(SEEN_KEY, newest);
    return seen !== null;
  } catch {
    // Refused storage: never open on every launch.
    return false;
  }
}
