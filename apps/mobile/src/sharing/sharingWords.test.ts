import { grantedWho, namesOf, receivedWho, sharingWords, type ShareGrant, type ShareLevel } from "@dohc/interface-words/sharing";
import { confirmWords } from "@dohc/interface-words/confirmations";
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { describe, expect, it } from "vitest";
import { cutMiddle } from "./cutMiddle";

const person = (who: string, level: ShareLevel): ShareGrant => ({ via: "named", level, who });
const link = (level: ShareLevel): ShareGrant => ({ via: "link", level, who: "" });

describe("who can do what with a share", () => {
  it("says the DL's examples", () => {
    expect(grantedWho([person("Maya", "edit")])).toBe("Maya can edit");
    expect(grantedWho([link("view")])).toBe("Anyone with the link can view");
    expect(grantedWho([person("a", "edit"), person("b", "view"), person("c", "edit")])).toBe("2 people can edit, 1 can view");
    expect(grantedWho([person("a", "edit"), person("b", "view"), person("c", "view")])).toBe("1 person can edit, 2 can view");
    expect(grantedWho([person("a", "edit"), link("view")])).toBe("1 person can edit, anyone with the link can view");
    expect(grantedWho([link("comment")])).toBe("Anyone with the link can comment");
  });

  it("counts only people above the widest link, and links by level when there are several", () => {
    expect(grantedWho([person("a", "view"), link("comment")])).toBe("Anyone with the link can comment");
    expect(grantedWho([link("view"), link("edit"), person("a", "edit")])).toBe("Anyone with a link can edit");
    expect(grantedWho([])).toBeNull();
  });

  it("names a received share's sender, with the level only while it's live", () => {
    expect(receivedWho("Priya Raman", "comment")).toEqual({ text: "Priya Raman lets you comment", spoken: "Priya Raman lets you comment" });
    expect(receivedWho("Maya Chen", null)).toEqual({ text: "From Maya Chen", spoken: "from Maya Chen" });
  });
});

describe("the End share and Forget alerts", () => {
  it("name the file, and what Undo can't restore", () => {
    expect(sharingWords.endTitle("packing-list.md")).toBe("End the share of packing-list.md?");
    expect(sharingWords.endWaitingTitle("packing-list.md", 2, ["sam@example.com"]))
      .toBe("End the share of packing-list.md and decline 2 changes sam@example.com sent?");
    expect(sharingWords.endWaitingTitle("a.md", 1, ["a", "b", "c", "d"])).toBe("End the share of a.md and decline 1 change 4 people sent?");
    expect(sharingWords.endWaitingBody(2)).toBe("Undo restores the share, not the declined changes.");
    expect(sharingWords.endWaitingBody(1)).toBe("Undo restores the share, not the declined change.");
    expect(confirmWords.forgetTitle("Lisbon trip")).toBe("Forget Lisbon trip?");
    expect(confirmWords.forgetWaiting(2)).toBe("2 messages are waiting to send from this phone. Forget deletes them. Undo restores the workspace, not the messages.");
    expect(confirmWords.forgetWaiting(1)).toBe("1 message is waiting to send from this phone. Forget deletes it. Undo restores the workspace, not the message.");
  });
});

// Until these words move into a package both apps import, the phone's must say what the desktop's say. This branch
// sits on an older main, so the test takes the desktop's own functions from SharingView.tsx at the main commit the
// words came from, strips their types, and runs them beside the phone's on the same shares.
const DESKTOP_AT = "45b0de8020a59d47358a9aa1f00ace9d86d8b076";
const desktopSource = execFileSync("git", ["show", `${DESKTOP_AT}:apps/desktop/src/renderer/workbench/SharingView.tsx`], { encoding: "utf8" });
const functionNamed = (name: string) => {
  const start = desktopSource.indexOf(`function ${name}(`);
  const end = desktopSource.indexOf("\n}\n", start);
  if (start < 0 || end < 0) throw new Error(`SharingView.tsx has no function ${name}`);
  return desktopSource.slice(start, end + 2);
};
const lineStarting = (prefix: string) => {
  const line = desktopSource.split("\n").find(each => each.startsWith(prefix));
  if (!line) throw new Error(`SharingView.tsx has no ${prefix}`);
  return line;
};
interface DesktopRow { readonly status: "active"; readonly via: "named" | "link"; readonly access: ShareLevel; readonly recipientEmail: string | null; readonly recipientUserId: null }
interface DesktopWords {
  grantedWho(group: { rows: readonly DesktopRow[] }): { text: string } | null;
  endConfirmWords(group: { rows: readonly DesktopRow[] }, waiting: { count: number; senders: readonly string[] } | undefined): string;
  fromWho(sender: string, full: string): { text: string; spoken?: string };
  namesOf(names: readonly string[], none: string): string;
  WORD_SHOWN: Record<string, string>;
}
const desktopFunctions = stripTypeScriptTypes([
  lineStarting("const VERBS"), lineStarting("const verbOf"), lineStarting("const WORD_SHOWN"),
  ...["countClauses", "linkClauses", "grantedWho", "fromWho", "recipientOf", "endsOnEnd", "recipientNames", "namesOf", "recipientsOf",
    "endConfirmWords"].map(functionNamed),
].join("\n"));
const desktopWords = new Function("LEVELS", `${desktopFunctions}\nreturn { grantedWho, endConfirmWords, fromWho, namesOf, WORD_SHOWN };`)({ view: { label: "View" }, comment: { label: "Comment" }, edit: { label: "Edit" } }) as DesktopWords;
const rowsOf = (grants: readonly ShareGrant[]) => ({
  rows: grants.map((grant): DesktopRow => ({ status: "active", via: grant.via, access: grant.level, recipientEmail: grant.via === "link" ? null : grant.who, recipientUserId: null })),
});

describe("the desktop's Sharing words", () => {
  const shares: readonly (readonly ShareGrant[])[] = [
    [person("maya@example.com", "edit")], [link("view")], [link("comment")],
    [person("a", "edit"), person("b", "view"), person("c", "edit")], [person("a", "edit"), person("b", "view"), person("c", "view")],
    [person("a", "edit"), link("view")], [person("a", "view"), link("comment")], [link("view"), link("edit"), person("a", "edit")],
    [link("view"), link("comment"), link("comment")], [person("a", "comment"), person("b", "comment")], [],
  ];
  it.each(shares.map(grants => [grantedWho(grants) ?? "nothing", grants] as const))("says %s as the desktop does", (_, grants) => {
    expect(grantedWho(grants)).toBe(desktopWords.grantedWho(rowsOf(grants))?.text ?? null);
  });

  it("ends a share with the desktop's words, the phone's alert naming the file", () => {
    for (const people of [["sam@example.com"], ["a", "b"], ["a", "b", "c", "d"]]) {
      const grants = people.map(who => person(who, "edit"));
      expect(`End this share? ${sharingWords.endBody(people)}`).toBe(desktopWords.endConfirmWords(rowsOf(grants), undefined));
      for (const count of [1, 3]) {
        const phone = `${sharingWords.endWaitingTitle("trip/a.md", count, people)} ${sharingWords.endWaitingBody(count)}`;
        expect(phone.replace("End the share of trip/a.md", "End this share")).toBe(desktopWords.endConfirmWords(rowsOf(grants), { count, senders: people }));
      }
    }
  });

  it("names people, senders and statuses as the desktop does", () => {
    for (const names of [[], ["a"], ["a", "b"], ["a", "b", "c"], ["a", "b", "c", "d"]]) {
      expect(namesOf(names, "the recipient")).toBe(desktopWords.namesOf(names, "the recipient"));
    }
    const from = desktopWords.fromWho("Maya Chen", "Maya Chen (maya@example.com)");
    expect(receivedWho("Maya Chen", null)).toEqual({ text: from.text, spoken: from.spoken });
    // The live level is written inline in the desktop's ReceivedRow.
    expect(desktopSource).toContain("{ text: `${sender} lets you ${verbOf(access)}`");
    expect(receivedWho("Priya Raman", "comment").text).toBe("Priya Raman lets you comment");
    expect(sharingWords.status).toEqual(desktopWords.WORD_SHOWN);
  });
});

describe("cutMiddle", () => {
  it("keeps a short name and cuts a long one around its middle", () => {
    expect(cutMiddle("packing-list.md", 24)).toBe("packing-list.md");
    const cut = cutMiddle("2026-lisbon-trip-shared-itinerary-final.md", 24);
    expect(Array.from(cut)).toHaveLength(24);
    expect(cut).toBe("2026-lisbon-…ry-final.md");
  });
});
