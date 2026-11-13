import { describe, expect, it } from "vitest";
import {
  noticeRowAccessibility,
  noticeRowHandlers,
  shortAgo,
  spokenAgo,
  swipesUnread,
} from "./rowAccessibility";
import type { PhoneNotice } from "./phoneNotice";

const base: PhoneNotice = {
  id: "n",
  senderKind: "person",
  senderLabel: "Maya Chen",
  title: "Maya Chen mentioned you in #planning",
  body: "Can you check the train times for the 15th?",
  minutesAgo: 2,
  read: false,
  dismissible: true,
};

// VoiceOver's rotor lists a row's actions in this order. The UI test can't open the rotor, so this guards it.
describe("a Notices row's actions", () => {
  it("puts the worded action first, then Copy, then Dismiss", () => {
    expect(
      noticeRowAccessibility({ ...base, open: "open" }).actions.map((action) => action.label),
    ).toEqual(["Open", "Copy notice details", "Dismiss notice"]);
    expect(
      noticeRowAccessibility({ ...base, retry: true, failed: true }).actions.map(
        (action) => action.label,
      ),
    ).toEqual(["Try again", "Copy error details", "Dismiss notice"]);
    expect(
      noticeRowAccessibility({ ...base, open: "openNote" }).actions.map((action) => action.label),
    ).toEqual(["Open note", "Copy notice details", "Dismiss notice"]);
  });

  it("gives a Notice from the server Mark read or Mark unread after the worded action, and Done", () => {
    expect(
      noticeRowAccessibility({ ...base, relayId: "n", open: "open" }).actions.map(
        (action) => action.label,
      ),
    ).toEqual(["Open", "Mark read", "Copy notice details", "Done"]);
    expect(
      noticeRowAccessibility({ ...base, relayId: "n", read: true }).actions.map(
        (action) => action.label,
      ),
    ).toEqual(["Mark unread", "Copy notice details", "Done"]);
  });

  it("swipes right only to mark a read Notice from the server unread", () => {
    expect(swipesUnread({ ...base, relayId: "n", read: true })).toBe(true);
    expect(swipesUnread({ ...base, relayId: "n", read: false })).toBe(false);
    expect(swipesUnread({ ...base, read: true })).toBe(false);
    expect(swipesUnread({ ...base, relayId: "n", read: true, dismissible: false })).toBe(false);
  });

  it("leaves out what the row doesn't have", () => {
    expect(noticeRowAccessibility(base).actions.map((action) => action.label)).toEqual([
      "Copy notice details",
      "Dismiss notice",
    ]);
    expect(
      noticeRowAccessibility({ ...base, dismissible: false }).actions.map((action) => action.label),
    ).toEqual(["Copy notice details"]);
  });
});

describe("a Notices row's time", () => {
  // Noon on Nov 5, local time, so the date cases don't depend on when the test runs.
  const now = new Date(2026, 10, 5, 12, 0).getTime();
  it("shows the desktop's words", () => {
    expect([shortAgo(0, now), shortAgo(2, now), shortAgo(180, now)]).toEqual([
      "just now",
      "2m ago",
      "3h ago",
    ]);
    expect(shortAgo(24 * 60, now)).toBe("Nov 4");
  });

  it("speaks them in full", () => {
    expect([
      spokenAgo(0, now),
      spokenAgo(1, now),
      spokenAgo(2, now),
      spokenAgo(60, now),
      spokenAgo(180, now),
    ]).toEqual(["just now", "1 minute ago", "2 minutes ago", "1 hour ago", "3 hours ago"]);
    expect(spokenAgo(24 * 60, now)).toBe("November 4");
  });

  it("speaks the full time in the row's label", () => {
    expect(noticeRowAccessibility(base).label).toBe(
      "Unread, From a person, Maya Chen mentioned you in #planning, Can you check the train times for the 15th?, 2 minutes ago",
    );
    expect(
      noticeRowAccessibility({ ...base, minutesAgo: 180, read: true, folder: "Fundraiser" }).label,
    ).toBe(
      "From a person, Maya Chen mentioned you in #planning, Can you check the train times for the 15th?, 3 hours ago · Fundraiser",
    );
  });
});

// A row once offered Copy with nothing behind it. Every action a row offers, on its pill or in the rotor, needs a
// handler; a row that can't act on one must not offer it.
describe("a Notices row's handlers", () => {
  const all = {
    open: () => {},
    retry: () => {},
    setRead: () => {},
    copy: () => {},
    dismiss: () => {},
  };
  const rows: PhoneNotice[] = [
    { ...base, open: "open" },
    { ...base, open: "openNote" },
    { ...base, retry: true, failed: true },
    { ...base, dismissible: false },
    base,
    { ...base, relayId: "n", open: "open" },
    { ...base, relayId: "n", read: true, elsewhere: true },
    { ...base, relayId: "n", dismissible: false },
  ];

  it("has one for every action the row offers", () => {
    for (const notice of rows) {
      const handlers = noticeRowHandlers(notice, all);
      for (const action of noticeRowAccessibility(notice).actions) {
        expect(handlers[action.name], `${notice.title}: ${action.label}`).toBeTypeOf("function");
      }
    }
  });

  it("keeps a failure held on this phone to its own actions, with no mark sent to the server", () => {
    const handlers = noticeRowHandlers({ ...base, retry: true, failed: true }, all);
    expect(handlers.read).toBeUndefined();
  });

  it("marks a Notice from the server the way its control says", () => {
    const marks: boolean[] = [];
    const setRead = (read: boolean) => void marks.push(read);
    noticeRowHandlers({ ...base, relayId: "n" }, { ...all, setRead }).read?.();
    noticeRowHandlers({ ...base, relayId: "n", read: true }, { ...all, setRead }).read?.();
    expect(marks).toEqual([true, false]);
  });

  it("has none for a worded action the phone can't do yet", () => {
    expect(
      noticeRowHandlers({ ...base, open: "open" }, { ...all, open: undefined }).worded,
    ).toBeUndefined();
  });
});
