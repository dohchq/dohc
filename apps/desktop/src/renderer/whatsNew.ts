import { Bot, ContactRound, History, Link } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface WhatsNewItem {
  icon: LucideIcon;
  title: string;
  body: string;
}

export interface WhatsNewRelease {
  // The version that first shipped these notes. Never reused: a new one
  // opens the tab once after an update.
  version: string;
  // When it shipped, as YYYY-MM-DD.
  date: string;
  items: readonly WhatsNewItem[];
  // One sentence per fix: what is true now that it shipped.
  fixes: readonly string[];
}

// Newest first. Add a release here when an update brings something people
// should know about; updates without a new entry open nothing.
export const WHATS_NEW: readonly WhatsNewRelease[] = [
  {
    version: "0.1.1",
    date: "2026-11-10",
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
    fixes: [
      "Unread chats now look the same on every row.",
      "A name inside a file link no longer counts as a mention.",
      "Go to says no file matches, instead of no matching commands.",
      "An app that sets no colors now reads correctly in the dark theme.",
      "The default accent color follows a switch of the system theme.",
      "Shared-file notices now say why they appeared.",
    ],
  },
];

const SEEN_KEY = "dohc.whatsNew.seen";

// True once per new release. A first launch records the newest release
// without opening it, so a new install starts on the person's work.
export function takeUnseenWhatsNew(storage: Pick<Storage, "getItem" | "setItem"> = localStorage): boolean {
  const newest = WHATS_NEW[0]?.version;
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

// Windows open together after a restart; the lock lets only one of them
// take the new release.
export async function claimUnseenWhatsNew(): Promise<boolean> {
  try {
    return await navigator.locks.request(SEEN_KEY, () => takeUnseenWhatsNew());
  } catch {
    return false;
  }
}
