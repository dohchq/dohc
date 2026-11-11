// The eval's cases. Each reproduces a real experience or guards a real one, and names its
// source. README.md says how to add one. All names and data are made up.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { creationPartialMessage, type CreationPartial } from "@dohc/cli/creation";
import type { EvalCase } from "./case";
import { workspaceVerbs } from "./desktop";

type Args = Record<string, unknown>;

const AT = 1_760_000_000_000;

function thread(id: string, title: string, linkedPathHint?: string) {
  return { id, title, createdAtMs: AT, updatedAtMs: AT, ...(linkedPathHint ? { linkedPathHint } : {}) };
}

function message(id: string, threadId: string, body: string, more: Args = {}) {
  return { id, threadId, authorKind: "human", authorDisplayName: "Dana", body, createdAtMs: AT, attachments: [], needsDecision: false, ...more };
}

/** What the dohc app answers when a thread is read. */
function threadRead(read: ReturnType<typeof thread>, messages: ReturnType<typeof message>[]) {
  return {
    ok: true,
    thread: read,
    dispatch: { paused: null, lastRun: null },
    messages,
    projection: { path: `chats/${read.id}.md`, readOnly: true, text: messages.map((each) => `${each.authorDisplayName}: ${each.body}`).join("\n") },
  };
}

function group(id: string, name: string, kind: "group" | "dm", threads: { id: string; title: string }[] = []) {
  return {
    id, name, slug: name.toLowerCase().replace(/\s+/g, "-"), kind, threadCount: threads.length,
    threads: threads.map((each) => ({ ...each, messageCount: 2, updatedAtMs: AT })),
  };
}

const GROUPS = {
  ok: true,
  groups: [
    group("channel-general", "General", "group"),
    group("channel-planning", "Planning", "group", [{ id: "thread-launch", title: "Launch day" }]),
    group("channel-archive", "Old plans", "group"),
    group("channel-dana", "Dana", "dm"),
  ],
};

/** What the dohc app answers when a post starts a thread. The MCP server turns these handles into engine ids. */
function posted(args: Args) {
  const name = String(args.group).replace(/^#/, "");
  return { group: { id: "ch_posted", name, slug: name.toLowerCase(), kind: "group" }, threadId: "th_posted", messageId: "msg_posted", title: "" };
}

const NO_DOHC_WORK = { notCalls: ["dohc_*", "Edit", "Write"] };

const PARTIAL_RECORD: CreationPartial = {
  kind: "partial",
  created: ["tasks/Book venue.md"],
  failedStage: "index",
  reason: "The Collection did not answer.",
  retry: { mode: "resume", instruction: "Try again with the same record ID to check this draft without creating another record.", recordId: "rec_abcdefghijklmnopqrstuvwxyz" },
};

// One sample is one server process, so these count within a sample.
let waits = 0;
let edits = 0;
let recordFinished = false;
const keyedEdits = new Map<string, unknown>();

export const CASES: readonly EvalCase[] = [
  {
    id: "file-comment-starts-file-chat",
    kind: "bad",
    experience: "An agent asked to comment on budget.md started a group chat with the file attached, and the chat never showed in the file's Chats panel.",
    source: "#1219",
    files: { "budget.md": "# Budget\n\nTravel: 400\nFood: 250\n" },
    desktop: {
      fileChatStart: { ok: true, path: "budget.md", threadId: "thread-comment", messageId: "message-comment" },
      fileChats: { ok: true, path: "budget.md", fileObjectId: "object-budget", threads: [] },
      groupsFull: GROUPS,
      post: posted,
    },
    prompt: "Leave a comment on budget.md for Dana: \"Please check the travel allowance.\"",
    expect: {
      calls: [{ tool: "dohc_start_file_chat", args: { path: "budget.md", body: "~travel allowance" }, ok: true }],
      notCalls: ["dohc_start_group_chat", "dohc_edit_document", "Edit", "Write"],
      files: { "budget.md": { lacks: ["Please check"] } },
    },
    solution: { calls: [{ tool: "dohc_start_file_chat", args: { path: "budget.md", title: "Travel allowance", body: "Please check the travel allowance." } }] },
  },
  {
    id: "file-chat-reply-continues-thread",
    kind: "guard",
    experience: "An agent could not find a file's existing conversation, so it had no way to continue it without starting another.",
    source: "#2000",
    files: { "budget.md": "# Budget\n\nTravel: 400\nFood: 250\nTotal: 650\n" },
    desktop: {
      fileChats: {
        ok: true, path: "budget.md", fileObjectId: "object-budget",
        threads: [thread("thread-venue", "Venue deposit", "budget.md"), thread("thread-totals", "Do the totals add up?", "budget.md")],
      },
      chat: (args: Args) => args.threadId === "thread-totals"
        ? threadRead(thread("thread-totals", "Do the totals add up?", "budget.md"), [message("message-t1", "thread-totals", "Travel and food come to 650. Can someone check?")])
        : threadRead(thread("thread-venue", "Venue deposit", "budget.md"), [message("message-v1", "thread-venue", "The venue wants a 200 deposit by Friday.")]),
      reply: (args: Args) => ({ threadId: String(args.thread), messageId: "msg_reply" }),
      groupsFull: GROUPS,
    },
    prompt: "In the discussion on budget.md about whether the totals add up, reply: \"The totals are checked.\"",
    expect: {
      calls: [
        { tool: "dohc_list_file_chats", args: { path: "budget.md" } },
        { tool: "dohc_reply_to_chat", args: { threadId: "thread-totals", body: "~totals are checked" }, ok: true },
      ],
      notCalls: ["dohc_start_file_chat", "dohc_start_group_chat", { tool: "dohc_reply_to_chat", args: { threadId: "thread-venue" } }],
    },
    solution: {
      calls: [
        { tool: "dohc_list_file_chats", args: { path: "budget.md" } },
        { tool: "dohc_reply_to_chat", args: { threadId: "thread-totals", body: "The totals are checked." } },
      ],
    },
  },
  {
    id: "group-post-finds-the-group",
    kind: "guard",
    experience: "Agents read \"channels\" while people saw \"Groups\", and the list also holds direct messages told apart only by kind.",
    source: "#1205",
    desktop: { groupsFull: GROUPS, post: posted },
    prompt: "Post \"Draft ready for review\" in the Planning group.",
    expect: {
      calls: [{ tool: "dohc_start_group_chat", args: { group: "~planning", body: "~draft ready" }, ok: true }],
      notCalls: [
        { tool: "dohc_start_group_chat", args: { group: "~general" } },
        { tool: "dohc_start_group_chat", args: { group: "~archive" } },
        { tool: "dohc_start_group_chat", args: { group: "~old plans" } },
        { tool: "dohc_start_group_chat", args: { group: "~dana" } },
      ],
      maxCalls: { dohc_start_group_chat: 1 },
    },
    solution: { calls: [{ tool: "dohc_start_group_chat", args: { group: "Planning", body: "Draft ready for review" } }] },
  },
  {
    id: "group-stream-poll-is-answered",
    kind: "guard",
    experience: "Reading a group's stream left out polls, so an agent could not tell a poll from an ordinary post.",
    source: "#3113, #2829",
    desktop: {
      groupsFull: GROUPS,
      chat: (args: Args) => args.group !== undefined
        ? {
            ok: true,
            stream: {
              group: { id: "channel-planning", name: "Planning", kind: "group" },
              items: [
                {
                  position: { createdAtMs: AT, lane: "posts", id: "thread-lunch" }, threadId: "thread-lunch",
                  message: message("message-lunch", "thread-lunch", "Lunch is at noon on Friday."),
                  post: { replyCount: 0, repliers: [], openDecisionCount: 0 },
                },
                {
                  position: { createdAtMs: AT + 1, lane: "posts", id: "thread-launch" }, threadId: "thread-launch",
                  message: message("message-poll", "thread-launch", "Which day do we launch?", { needsDecision: true, decisionState: "open", options: ["Thursday", "Friday"] }),
                  post: { replyCount: 0, repliers: [], openDecisionCount: 1 },
                },
              ],
              nextBefore: null,
              readPosition: null,
            },
          }
        : threadRead(thread("thread-launch", "Launch day"), [
            message("message-poll", "thread-launch", "Which day do we launch?", { needsDecision: true, decisionState: "open", options: ["Thursday", "Friday"] }),
          ]),
      reply: (args: Args) => ({ threadId: String(args.thread), messageId: "msg_answer", ...(args.resolve ? { resolvedMessageId: String(args.resolve) } : {}) }),
    },
    prompt: "There is an open poll about the launch day in the Planning group. Answer it with Friday.",
    expect: {
      calls: [{ tool: "dohc_reply_to_chat", args: { threadId: "thread-launch", resolve: "message-poll", choose: "Friday" }, ok: true }],
      notCalls: ["dohc_start_group_chat", { tool: "dohc_reply_to_chat", args: { threadId: "thread-lunch" } }],
      maxCalls: { dohc_reply_to_chat: 1 },
    },
    solution: {
      calls: [
        { tool: "dohc_read_chat", args: { group: "Planning" } },
        { tool: "dohc_reply_to_chat", args: { threadId: "thread-launch", resolve: "message-poll", choose: "Friday", body: "Friday" } },
      ],
    },
  },
  {
    id: "answered-poll-is-not-asked-again",
    kind: "bad",
    experience: "When an agent asked a poll and the person answered it, the agent sometimes asked the same question again.",
    source: "#2394",
    files: { "notes/plan.txt": "Launch day: to be decided\n" },
    desktop: {
      groupsFull: GROUPS,
      chat: threadRead(thread("thread-launch", "Launch day"), [
        message("message-poll", "thread-launch", "Which day do we launch?", {
          authorKind: "agent", authorDisplayName: "Agent", needsDecision: true, decisionState: "resolved",
          options: ["Thursday", "Friday"], chosenOption: "Friday", resolvedByMessageId: "message-answer",
        }),
        message("message-answer", "thread-launch", "Friday", { parentMessageId: "message-poll" }),
      ]),
      reply: (args: Args) => ({ threadId: String(args.thread), messageId: "msg_done" }),
      post: posted,
    },
    prompt: "I answered your launch-day question in the thread thread-launch. Carry on: put the day I chose into notes/plan.txt.",
    expect: {
      calls: [{ tool: "dohc_read_chat", args: { threadId: "thread-launch" } }],
      notCalls: [
        { tool: "dohc_reply_to_chat", args: { needsDecision: true } },
        { tool: "dohc_reply_to_chat", args: { options: "*" } },
        { tool: "dohc_start_group_chat", args: { needsDecision: true } },
        { tool: "dohc_start_group_chat", args: { options: "*" } },
      ],
      files: { "notes/plan.txt": { contains: ["Friday"] } },
    },
    solution: {
      calls: [
        { tool: "dohc_read_chat", args: { threadId: "thread-launch" } },
        { tool: "dohc_write_file", args: { path: "notes/plan.txt", content: "Launch day: Friday\n" } },
      ],
    },
  },
  {
    id: "history-reads-the-change",
    kind: "guard",
    experience: "An agent could not answer what changed in a file since its last version, because nothing listed or showed a file's changes.",
    source: "#1325",
    files: { "proposal.md": "# Proposal\n\nBudget: 5,500\n" },
    desktop: {
      moments: {
        changes: [
          { id: "moment-2", recordedAtMs: AT + 60_000, source: "workspace-engine", operation: "write", path: "proposal.md", versionId: "version-main", fileCount: 1 },
          { id: "moment-1", recordedAtMs: AT, source: "workspace-engine", operation: "write", path: "proposal.md", versionId: "version-main", fileCount: 1 },
        ],
        count: 2, totalAvailable: 2, hasMore: false, cursorMs: AT,
      },
      moment: (args: Args) => args.id === "moment-2"
        ? {
            ok: true,
            change: {
              id: "moment-2", recordedAtMs: AT + 60_000, source: "workspace-engine", operation: "write", path: "proposal.md", versionId: "version-main", fileCount: 1,
              files: [{ path: "proposal.md", operation: "write" }],
              before: { path: "proposal.md", text: "# Proposal\n\nBudget: 4,000\n" },
              after: { path: "proposal.md", text: "# Proposal\n\nBudget: 5,500\n" },
            },
          }
        : { ok: false, reason: "No change has that id." },
    },
    prompt: "What changed in proposal.md in its latest change?",
    expect: {
      calls: [{ tool: "dohc_list_changes", args: { path: "proposal.md" }, ok: true }, { tool: "dohc_read_change", args: { id: "moment-2" }, ok: true }],
      text: ["4,?000", "5,?500"],
    },
    solution: {
      calls: [{ tool: "dohc_list_changes", args: { path: "proposal.md" } }, { tool: "dohc_read_change", args: { id: "moment-2" } }],
      text: "The budget went from 4,000 to 5,500.",
    },
  },
  {
    id: "wait-then-answer",
    kind: "guard",
    experience: "An agent that wanted a person's next message had to poll, which wasted its turns, or stop and miss the reply.",
    source: "#3347",
    files: { "venues.md": "# Venue shortlist\n\n- Harbour Hall\n- The Old Mill\n" },
    desktop: {
      // The first wait brings the person's message. A later one brings nothing more.
      watch: () => {
        waits += 1;
        return waits === 1
          ? {
              messages: [{
                threadId: "thread-ask", messageId: "message-ask",
                group: { id: "channel-planning", name: "Planning", slug: "planning", kind: "group" },
                author: { kind: "human", displayName: "Dana" }, createdAtMs: AT, text: "Which file has the venue shortlist?",
              }],
              cursor: "cursor-1",
            }
          : { messages: [], cursor: "cursor-2" };
      },
      chat: threadRead(thread("thread-ask", "Venue shortlist"), [message("message-ask", "thread-ask", "Which file has the venue shortlist?")]),
      reply: (args: Args) => ({ threadId: String(args.thread), messageId: "msg_answer" }),
      groupsFull: GROUPS,
    },
    prompt: "Wait for my next message in dohc, then answer it there.",
    expect: {
      calls: [{ tool: "dohc_wait_for_messages" }, { tool: "dohc_reply_to_chat", args: { threadId: "thread-ask", body: "~venues.md" }, ok: true }],
      order: ["dohc_wait_for_messages", "dohc_reply_to_chat"],
      maxCalls: { dohc_reply_to_chat: 1, dohc_read_chat: 2 },
    },
    solution: {
      calls: [
        { tool: "dohc_wait_for_messages", args: {} },
        { tool: "dohc_reply_to_chat", args: { threadId: "thread-ask", body: "The shortlist is in venues.md." } },
      ],
    },
  },
  {
    id: "app-is-created-and-checked",
    kind: "guard",
    experience: "The tools were named for sites while people saw apps, and no page listed them, so agents found them by guessing.",
    source: "#1297",
    prompt: "Create a small app called RSVP in apps/rsvp, then check that its entry files are in place.",
    expect: {
      calls: [{ tool: "dohc_create_app", args: { appRoot: "apps/rsvp" }, ok: true }, { tool: "dohc_test_app", args: { appRoot: "apps/rsvp" } }],
      order: ["dohc_create_app", "dohc_test_app"],
      files: { "apps/rsvp/index.html": { contains: ["<"] } },
    },
    solution: {
      calls: [{ tool: "dohc_create_app", args: { appRoot: "apps/rsvp", title: "RSVP" } }, { tool: "dohc_test_app", args: { appRoot: "apps/rsvp" } }],
    },
  },
  {
    id: "file-write-goes-through-dohc",
    kind: "guard",
    experience: "A file an agent wrote showed in History as a local edit with no author, because the write did not go through the dohc app.",
    source: "#1477",
    files: { "settings.json": "{\n  \"theme\": \"light\"\n}\n" },
    prompt: "Set the theme to dark in settings.json. Use dohc's tools, so History shows the change as yours.",
    expect: {
      calls: [{ tool: "dohc_write_file", args: { path: "settings.json", content: "~dark" }, ok: true }],
      notCalls: ["Edit", "Write"],
      files: { "settings.json": { contains: ["dark"], lacks: ["light"] } },
    },
    solution: { calls: [{ tool: "dohc_write_file", args: { path: "settings.json", content: "{\n  \"theme\": \"dark\"\n}\n" } }] },
  },
  {
    id: "document-is-created-as-a-document",
    kind: "guard",
    experience: "Agents could read and edit documents but not create one, and a raw file write of Markdown is refused.",
    source: "#1219, #1173",
    prompt: "Create a document agenda.md in dohc with three agenda items: Budget, Venue, Invitations.",
    expect: {
      calls: [{ tool: "dohc_create_document", args: { path: "agenda.md" }, ok: true }],
      notCalls: ["dohc_write_file"],
      files: { "agenda.md": { contains: ["Budget", "Venue", "Invitations"] } },
    },
    solution: { calls: [{ tool: "dohc_create_document", args: { path: "agenda.md", markdown: "# Agenda\n\n- Budget\n- Venue\n- Invitations\n" } }] },
  },
  {
    id: "markdown-edit-takes-either-route",
    kind: "guard",
    experience: "dohc refuses a raw file write of a Markdown document. The document tools and the agent's own file tools both change it.",
    source: "#1173, #1214",
    files: { "notes/plan.md": "# Plan\n\nWe launch on Tuesday.\n" },
    prompt: "In notes/plan.md, move the launch from Tuesday to Thursday.",
    expect: {
      notCalls: ["dohc_write_file"],
      files: { "notes/plan.md": { contains: ["Thursday"], lacks: ["Tuesday"] } },
    },
    solution: {
      calls: [
        { tool: "dohc_read_document", args: { path: "notes/plan.md" } },
        { tool: "dohc_edit_document", args: { path: "notes/plan.md", find: "Tuesday", replacement: "Thursday" } },
      ],
    },
  },
  {
    id: "lost-answer-edit-is-not-applied-twice",
    kind: "guard",
    experience: "An edit can land while its answer is lost. Sent again without the same request key, it applies twice.",
    source: "#1214",
    files: { "packing.md": "# Packing\n\n- Passport\n" },
    desktop: {
      // The first edit lands and its answer never arrives. A repeat with the same key gets the first result.
      documentEdit: async (args: Args, root: string) => {
        const key = typeof args.requestId === "string" ? args.requestId : undefined;
        if (key !== undefined && keyedEdits.has(key)) return keyedEdits.get(key);
        const result = await workspaceVerbs.documentEdit!(root, args);
        if (key !== undefined) keyedEdits.set(key, result);
        edits += 1;
        if (edits === 1) throw new Error("desktop app did not respond");
        return result;
      },
    },
    prompt: "Add the item \"- Bring an adapter\" to the end of packing.md. Use dohc's document tools.",
    expect: {
      calls: [{ tool: "dohc_edit_document", args: { path: "packing.md" } }],
      notCalls: ["dohc_write_file"],
      files: { "packing.md": { times: { "Bring an adapter": 1 } } },
    },
    solution: {
      calls: [
        { tool: "dohc_edit_document", args: { path: "packing.md", replacement: "- Bring an adapter", requestId: "0f8fad5b-d9cb-469f-a165-70867728950e" } },
        { tool: "dohc_edit_document", args: { path: "packing.md", replacement: "- Bring an adapter", requestId: "0f8fad5b-d9cb-469f-a165-70867728950e" } },
      ],
    },
  },
  {
    id: "posted-reply-is-not-posted-again",
    kind: "guard",
    experience: "A reply can post while closing its poll fails. The result says so, and posting again would repeat the answer.",
    source: "#1173",
    desktop: {
      groupsFull: GROUPS,
      chat: threadRead(thread("thread-launch", "Launch day"), [
        message("message-poll", "thread-launch", "Which day do we launch?", { needsDecision: true, decisionState: "open", options: ["Thursday", "Friday"] }),
      ]),
      // The reply posts. Closing the poll with it fails, and the result says so.
      reply: (args: Args) => ({
        threadId: "th_launch", messageId: "msg_answer",
        ...(args.resolve ? { warning: "reply msg_answer was posted, but decision msg_poll could not be resolved: decision update failed" } : {}),
      }),
    },
    prompt: "Answer the open poll in the thread thread-launch with Friday, then tell me whether the poll is closed.",
    expect: {
      calls: [{ tool: "dohc_reply_to_chat", args: { threadId: "thread-launch", resolve: "message-poll", choose: "Friday" }, ok: true }],
      maxCalls: { dohc_reply_to_chat: 1 },
      text: ["still open|stayed open|remains open|is open|not (been |yet )?(closed|resolved)|n't (been |yet )?(closed|resolved)|could not be (closed|resolved)|did not close|didn't close"],
    },
    solution: {
      calls: [
        { tool: "dohc_read_chat", args: { threadId: "thread-launch" } },
        { tool: "dohc_reply_to_chat", args: { threadId: "thread-launch", resolve: "message-poll", choose: "Friday", body: "Friday" } },
      ],
      text: "Your answer posted, but the poll is still open: dohc could not resolve it.",
    },
  },
  {
    id: "partial-record-is-finished-not-remade",
    kind: "guard",
    experience: "A record that was only partly created came back as a bare error, and nobody could tell what existed or how to finish it.",
    source: "#1468",
    files: { "tasks/Order catering.md": "---\nstatus: Todo\n---\n" },
    desktop: {
      // The first try saves the record's file and stops before the Collection lists it. A
      // retry with the record ID finishes it.
      collectionCreateRecord: (args: Args, root: string) => {
        writeFileSync(join(root, "tasks/Book venue.md"), "---\nstatus: Todo\n---\n");
        if (args.recordId !== PARTIAL_RECORD.retry.recordId) return { ok: false, reason: creationPartialMessage(PARTIAL_RECORD), partial: PARTIAL_RECORD };
        recordFinished = true;
        return { ok: true, recordId: PARTIAL_RECORD.retry.recordId, recordPath: "tasks/Book venue.md" };
      },
      collectionQuery: () => ({
        ok: true,
        collection: { path: "tasks", status: "valid", reasons: [] },
        records: [["rec_orderorderorderorderorderor", "tasks/Order catering.md"], ...(recordFinished ? [[PARTIAL_RECORD.retry.recordId, "tasks/Book venue.md"]] : [])]
          .map(([id, path]) => ({ id, path, conflicted: false, values: [{ field: "status", value: "Todo", validation: { status: "untyped" }, resolvedRelations: [] }] })),
        groups: null,
        nextCursor: null,
      }),
      // The workspace has no transactional Collections.
      dataset: { kind: "list", datasets: [], nextCursor: null },
    },
    prompt: "Add a task called \"Book venue\" with status Todo to the tasks Collection.",
    expect: {
      calls: [{ tool: "dohc_create_record", args: { collectionPath: "tasks", name: "Book venue", recordId: "rec_abcdefghijklmnopqrstuvwxyz" }, ok: true }],
      notCalls: ["dohc_create_document", "dohc_write_file", "Write"],
      maxCalls: { dohc_create_record: 2 },
    },
    solution: {
      calls: [
        { tool: "dohc_create_record", args: { collectionPath: "tasks", name: "Book venue", fields: { status: "Todo" } } },
        { tool: "dohc_create_record", args: { collectionPath: "tasks", name: "Book venue", fields: { status: "Todo" }, recordId: "rec_abcdefghijklmnopqrstuvwxyz" } },
      ],
    },
  },
  {
    id: "control-plain-question",
    kind: "control",
    experience: "A general question needs no workspace and no dohc tool.",
    source: "control",
    files: { "todo.txt": "buy tape\n" },
    prompt: "What is the difference between JSON and JSONL?",
    expect: { ...NO_DOHC_WORK, text: ["line"] },
    solution: { calls: [], text: "JSONL puts one JSON value on each line." },
  },
  {
    id: "control-rewrite-sentence",
    kind: "control",
    experience: "A rewrite of text given in the request is answered in the reply, with nothing saved.",
    source: "control",
    files: { "todo.txt": "buy tape\n" },
    prompt: "Rewrite this sentence more clearly: \"The meeting which was going to be held on Friday has been moved by us to Monday.\"",
    expect: { ...NO_DOHC_WORK, text: ["monday"] },
    solution: { calls: [], text: "We moved Friday's meeting to Monday." },
  },
  {
    id: "control-rename-in-snippet",
    kind: "control",
    experience: "A change to a code snippet given in the request is answered in the reply, with no file made.",
    source: "control",
    files: { "todo.txt": "buy tape\n" },
    prompt: "Rename the variable x to total in this snippet and show me the result:\n\nlet x = 0;\nfor (const n of items) x += n;\nreturn x;",
    expect: { ...NO_DOHC_WORK, text: ["total"] },
    solution: { calls: [], text: "let total = 0;" },
  },
];
