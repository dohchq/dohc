import { grantedWho, namesOf, receivedWho, sharingWords, type ShareGrant, type ShareLevel } from "@dohc/interface-words/sharing";
import { confirmWords } from "@dohc/interface-words/confirmations";
import { describe, expect, it } from "vitest";
import { cutMiddle } from "./cutMiddle";

const person = (who: string, level: ShareLevel): ShareGrant => ({ via: "named", level, who });
const link = (level: ShareLevel): ShareGrant => ({ via: "link", level, who: "" });

describe("who can do what with a share", () => {
  it("says the desktop's examples", () => {
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

describe("recipient names", () => {
  it.each([
    [[], "the recipient"], [["a"], "a"], [["a", "b"], "a and b"],
    [["a", "b", "c"], "a, b and c"], [["a", "b", "c", "d"], "4 people"],
  ] as const)("summarizes %j", (names, expected) => {
    expect(namesOf(names, "the recipient")).toBe(expected);
  });

  it("explains the retained copy for one or several recipients", () => {
    expect(sharingWords.endBody(["Sam"])).toBe("Sam keeps a read-only copy and stops receiving updates.");
    expect(sharingWords.endBody(["Sam", "Maya"]))
      .toBe("Sam and Maya keep read-only copies and stop receiving updates.");
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
