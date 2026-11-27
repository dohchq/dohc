import { syncProblemSentence } from "@dohc/interface-words/notices";
import { sharingWords } from "@dohc/interface-words/sharing";
import { createSampleOutbox, sampleScope } from "../conversation/sample";
import { demoMode } from "../demo";
import type { ChatMessage } from "../server/workspaceReads";
import type { MessageTarget, TargetRead } from "./noticeWrites";
import type { PhoneNotice } from "./phoneNotice";
// Sample notices for design review only, shaped like the server's: titles and bodies arrive as data.

export const sampleNotices: readonly PhoneNotice[] = [
  {
    id: "n1",
    senderKind: "person",
    senderLabel: "Maya Chen",
    title: "Maya Chen mentioned you in #planning",
    body: "Can you check the train times for the 15th?",
    minutesAgo: 2,
    read: false,
    open: "open",
    openChat: { id: "g-planning", name: "planning" },
    dismissible: true,
  },
  {
    id: "n2",
    senderKind: "agent",
    senderLabel: "Nova",
    title: "Nova finished updating the itinerary app",
    body: "Added the Porto day trip with the 8:09 out and 19:52 back.",
    minutesAgo: 6,
    read: false,
    open: "open",
    dismissible: true,
  },
  {
    id: "n3",
    senderKind: "automation",
    senderLabel: "Budget sync",
    title: "Automation “Budget sync” failed",
    body: "The exchange-rate source didn’t answer.",
    minutesAgo: 18,
    read: false,
    retry: true,
    dismissible: true,
    failed: true,
  },
  {
    id: "n4",
    senderKind: "automation",
    senderLabel: "Nova",
    title: "Your agent has work waiting",
    body: "Open dohc on a computer with your agent set up to run this step.",
    minutesAgo: 60,
    read: true,
    dismissible: false,
  },
  {
    id: "n5",
    senderKind: "person",
    senderLabel: "Sam Ortiz",
    title: "Sam Ortiz shared Budget with you",
    minutesAgo: 180,
    read: true,
    folder: "Fundraiser",
    open: "openNote",
    dismissible: true,
  },
  // Older, read rows, so the list runs well past the screen and a drag puts rows under the bar.
  {
    id: "n6",
    senderKind: "agent",
    senderLabel: "Nova",
    title: "Nova drafted the Porto day plan",
    body: "Trains both ways, lunch near Ribeira, and the 19:52 back.",
    minutesAgo: 300,
    read: true,
    open: "open",
    dismissible: true,
  },
  {
    id: "n7",
    senderKind: "person",
    senderLabel: "Maya Chen",
    title: "Maya Chen replied in #planning",
    body: "The 15th works. I'll book the tram tour.",
    minutesAgo: 1440,
    read: true,
    open: "open",
    openChat: { id: "g-planning", name: "planning" },
    dismissible: true,
  },
  {
    id: "n8",
    senderKind: "person",
    senderLabel: "Sam Ortiz",
    title: "Sam Ortiz commented on itinerary/days.md",
    body: "Can we move the Sintra day to the 17th?",
    minutesAgo: 2880,
    read: true,
    open: "open",
    dismissible: true,
  },
  {
    id: "n9",
    senderKind: "agent",
    senderLabel: "Nova",
    title: "Nova finished updating the packing list",
    body: "Added a rain jacket and the museum passes.",
    minutesAgo: 4320,
    read: true,
    open: "open",
    dismissible: true,
  },
];

/**
 * Design review only, in notices-reply, last in the list: a mention whose message the sample's Porto thread shows, so
 * it offers Reply, which opens that thread with the message chosen.
 */
export const replySample: PhoneNotice = {
  id: "n10",
  senderKind: "person",
  senderLabel: "Sam Ortiz",
  title: "Sam Ortiz mentioned you in #planning",
  body: "Can we leave a bit later? 8:09 is early after a late dinner.",
  minutesAgo: 5760,
  read: true,
  open: "reply",
  openChat: { id: "thread-porto", thread: "1", reply: "r2" },
  dismissible: true,
};

/** Design review only, in notices-answer: Nova's open poll and question in #planning, as a read of its chat shows them. */
const novaAsks = (id: string, body: string, options: readonly string[]): ChatMessage => ({
  id,
  threadId: "t-planning",
  authorKind: "agent",
  authorName: "Nova",
  body,
  createdAtMs: 0,
  parentMessageId: null,
  attachments: [],
  needsDecision: true,
  decisionState: "open",
  options,
  optionDetails: [],
  chosenOption: null,
  resolvedByMessageId: null,
  reactions: [],
});
const returnTrain = novaAsks("q-return", "Which return train should the itinerary use?", [
  "17:52",
  "19:52",
  "21:07",
]);
const albumName = novaAsks("q-album", "What should I call the shared photo album?", []);

/** Whose answers the sample's outbox keeps, and where: the conversation sample's. */
export const answerScope = { origin: sampleScope.origin, accountId: sampleScope.accountId };

/** The sample's read of #planning's chat, which isn't a post's. */
export const answerRead: TargetRead = {
  kind: "read",
  thread: { kind: "thread", id: "t-planning", title: "", messages: [returnTrain, albumName] },
  post: false,
};

/** The sample's outbox for answers, in memory: an answer it takes is saved 1.6 s later. */
export const answerOutbox = () => createSampleOutbox(null);

const asking = (id: string, title: string, question: ChatMessage) => ({
  notice: {
    id,
    senderKind: "agent" as const,
    senderLabel: "Nova",
    title,
    body: question.body,
    minutesAgo: 1,
    read: false,
    openChat: { id: "g-planning", name: "planning" },
    dismissible: true,
  },
  target: {
    workspaceId: sampleScope.workspaceId,
    threadId: question.threadId,
    messageId: question.id,
    answer: true as const,
  },
});

/**
 * Design review only, in notices-answer, first in the list: agent-run Notices whose rows answer Nova's open poll and
 * question in place, each with the question its target names.
 */
export const answerSamples: readonly {
  readonly notice: PhoneNotice;
  readonly target: MessageTarget;
}[] = [
  asking("n-answer-return", "Nova is waiting for your answer in #planning", returnTrain),
  asking("n-answer-album", "Nova has a question in #planning", albumName),
];

/** Design review only: the row a failed End share leaves, held on this phone. */
export const endFailedSample: PhoneNotice = {
  id: "n-end-failed",
  senderKind: null,
  senderLabel: "",
  read: false,
  retry: true,
  dismissible: true,
  failed: true,
  minutesAgo: 0,
  title:
    demoMode === "notice-clipped" || demoMode === "notice-clipped-open"
      ? sharingWords.endFailed(
          sharingWords.subject("itinerary/days.md, itinerary/stays.md, itinerary/food.md", [
            "maya@example.com",
            "priya@example.com",
            "leo@example.com",
          ]),
        )
      : sharingWords.endFailed(sharingWords.subject("trip/packing-list.md", ["sam@example.com"])),
  body: syncProblemSentence.serverUnreachable,
};
