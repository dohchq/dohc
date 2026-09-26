import { describe, expect, it } from "vitest";
import { documentButtonAccess } from "./documentButtonAccess";

describe("documentButtonAccess", () => {
  const share = (grantedSelector: unknown, ended = false) => ({
    shareId: "share-1", granterEmail: "owner@example.com", genericChatWritable: false, grantedSelector, ...(ended ? { ended } : {}),
  });
  const edit = (paths: string[], versionId: string | null = null) => share({ paths, versionId, access: "edit" });

  it("lets anyone who can edit this workspace press", () => {
    expect(documentButtonAccess(undefined, "Invoices")).toBe("press");
  });

  it("relays a press through an Edit grant on the Collection or a folder above it", () => {
    expect(documentButtonAccess(edit(["Invoices"]), "Invoices")).toBe("relayed");
    expect(documentButtonAccess(edit(["Billing"]), "Billing/Invoices")).toBe("relayed");
  });

  it.each([
    ["Edit on one record", edit(["Invoices/12.md"])],
    ["Edit on a sibling whose name starts the same", edit(["Invoice"])],
    ["Edit on a folder inside the Collection", edit(["Invoices/2026"])],
    ["a whole-workspace version share, which the relay refuses", edit([], "main")],
    ["Edit on a version", edit(["Invoices"], "draft")],
    ["View", share({ paths: ["Invoices"], versionId: null, access: "view" })],
    ["Comment", share({ paths: ["Invoices"], versionId: null, access: "comment" })],
    ["an ended share", share({ paths: ["Invoices"], versionId: null, access: "edit" }, true)],
    ["a damaged grant", share({ paths: [""], versionId: null, access: "edit" })],
    ["no grant at all", share(undefined)],
    ["a marker that lost its value", null],
  ])("refuses %s", (_name, shareView) => {
    expect(documentButtonAccess(shareView, "Invoices")).toBe("no-access");
  });
});
