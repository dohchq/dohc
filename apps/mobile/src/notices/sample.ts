import { syncProblemSentence } from "@dohc/interface-words/notices";
import { sharingWords } from "@dohc/interface-words/sharing";
import { demoMode } from "../demo";
// Sample notices for design review only, shaped like the relay's notices (RelayNotice): titles and bodies arrive as data.
export type SenderKind = "person" | "agent" | "automation";

export interface PhoneNotice {
  readonly id: string;
  /** Null for a failure held on this phone, which has no sender. */
  readonly senderKind: SenderKind | null;
  readonly senderLabel: string;
  readonly title: string;
  readonly body?: string;
  /** How long ago it arrived; the row shows "2m ago" and VoiceOver hears "2 minutes ago". */
  readonly minutesAgo: number;
  /** When it arrived, for a notice made on this phone: its time then counts from here, not from `minutesAgo`. */
  readonly atMs?: number;
  readonly read: boolean;
  /** Another workspace's name, shown beside the time. */
  readonly folder?: string;
  readonly open?: "open" | "openNote";
  /** Where Open goes, when the phone can go there: a chat. */
  readonly openChat?: { readonly id: string; readonly name: string };
  readonly retry?: boolean;
  /** What Try again does, for a failure held on this phone. */
  readonly onRetry?: () => void;
  /** A wake from the server waits for a computer; dismissing it would cancel it. */
  readonly dismissible: boolean;
  readonly failed?: boolean;
}

export const sampleNotices: readonly PhoneNotice[] = [
  { id: "n1", senderKind: "person", senderLabel: "Maya Chen", title: "Maya Chen mentioned you in #planning",
    body: "Can you check the train times for the 15th?", minutesAgo: 2, read: false, open: "open",
    openChat: { id: "g-planning", name: "planning" }, dismissible: true },
  { id: "n2", senderKind: "agent", senderLabel: "Nova", title: "Nova finished updating the itinerary app",
    body: "Added the Porto day trip with the 8:09 out and 19:52 back.", minutesAgo: 6, read: false, open: "open", dismissible: true },
  { id: "n3", senderKind: "automation", senderLabel: "Budget sync", title: "Automation “Budget sync” failed",
    body: "The exchange-rate source didn’t answer.", minutesAgo: 18, read: false, retry: true, dismissible: true, failed: true },
  { id: "n4", senderKind: "automation", senderLabel: "Nova", title: "Your agent has work waiting",
    body: "Open dohc on a computer with your agent set up to run this step.", minutesAgo: 60, read: true, dismissible: false },
  { id: "n5", senderKind: "person", senderLabel: "Sam Ortiz", title: "Sam Ortiz shared Budget with you",
    minutesAgo: 180, read: true, folder: "Fundraiser", open: "openNote", dismissible: true },
  // Older, read rows, so the list runs well past the screen and a drag puts rows under the bar.
  { id: "n6", senderKind: "agent", senderLabel: "Nova", title: "Nova drafted the Porto day plan",
    body: "Trains both ways, lunch near Ribeira, and the 19:52 back.", minutesAgo: 300, read: true, open: "open", dismissible: true },
  { id: "n7", senderKind: "person", senderLabel: "Maya Chen", title: "Maya Chen replied in #planning",
    body: "The 15th works. I'll book the tram tour.", minutesAgo: 1440, read: true, open: "open",
    openChat: { id: "g-planning", name: "planning" }, dismissible: true },
  { id: "n8", senderKind: "person", senderLabel: "Sam Ortiz", title: "Sam Ortiz commented on itinerary/days.md",
    body: "Can we move the Sintra day to the 17th?", minutesAgo: 2880, read: true, open: "open", dismissible: true },
  { id: "n9", senderKind: "agent", senderLabel: "Nova", title: "Nova finished updating the packing list",
    body: "Added a rain jacket and the museum passes.", minutesAgo: 4320, read: true, open: "open", dismissible: true },
];

/** Design review only: the row a failed End share leaves, held on this phone. */
export const endFailedSample: PhoneNotice = {
  id: "n-end-failed", senderKind: null, senderLabel: "", read: false, retry: true, dismissible: true, failed: true, minutesAgo: 0,
  title: demoMode === "notice-clipped" || demoMode === "notice-clipped-open"
    ? sharingWords.endFailed(sharingWords.subject("itinerary/days.md, itinerary/stays.md, itinerary/food.md",
      ["maya@example.com", "priya@example.com", "leo@example.com"]))
    : sharingWords.endFailed(sharingWords.subject("trip/packing-list.md", ["sam@example.com"])),
  body: syncProblemSentence.serverUnreachable,
};
