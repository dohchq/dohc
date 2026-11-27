// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CollectionTable } from "./NamedCollections";
import { jsonResponse, settle, setControlValue } from "./testing";

const ITEM = "item-field",
  AMOUNT = "amount-field";
type Edit = { idempotencyKey: string; value: unknown; expectedVersion: number };
let root: Root, host: HTMLElement, edits: Edit[], answers: Array<() => Response>;

function described(reversible: boolean) {
  return {
    datasetId: "trip",
    name: "Trip budget",
    revision: 1,
    revisionSha256: "a".repeat(64),
    tables: [
      {
        tableId: "records",
        name: "Trip budget",
        primaryFieldId: null,
        canCreate: false,
        canDelete: false,
        fields: [
          { fieldId: ITEM, name: "Item", type: "text", editable: false, reversible: false },
          { fieldId: AMOUNT, name: "Amount", type: "number", editable: true, reversible },
        ],
      },
    ],
  };
}

async function open(reversible = false) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const { operation, args } = JSON.parse(String(init?.body));
      if (operation === "collection")
        return jsonResponse({ ok: true, result: described(reversible) });
      if (operation === "collectionRecords")
        return jsonResponse({
          ok: true,
          result: {
            status: "ready",
            rows: [{ id: "hotel", version: 4, values: { [ITEM]: "Hotel", [AMOUNT]: 960 } }],
            nextCursor: null,
            files: {},
          },
        });
      edits.push(args as Edit);
      return answers.shift()!();
    }),
  );
  act(() =>
    root.render(
      <CollectionTable
        grantId="grant"
        collection={{ datasetId: "trip", name: "Trip budget" }}
        onDirty={() => {}}
      />,
    ),
  );
  await settle(() => host.querySelector("table") !== null);
}

const button = (name: string) =>
  [...host.querySelectorAll("button")].find(
    (each) => each.getAttribute("aria-label") === name || each.textContent === name,
  );

async function change(value: string) {
  act(() => button("Edit Amount: 960")!.click());
  setControlValue(host.querySelector("input")!, value);
  act(() => host.querySelector("form")!.requestSubmit());
}

beforeEach(() => {
  edits = [];
  answers = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("shows a field the owner keeps read-only as text, not as something to edit", async () => {
  await open();
  expect(button("Edit Item: Hotel")).toBeUndefined();
  expect(host.querySelector("tbody")!.textContent).toContain("Hotel");
});

it("sends the same change again with the same key when dohc could not confirm a save", async () => {
  await open();
  answers.push(
    () => {
      throw new TypeError("fetch failed");
    },
    () => jsonResponse({ ok: true, result: { saved: { version: 5 } } }),
  );
  await change("1010");
  await settle(() => host.textContent!.includes("dohc could not confirm the save"));
  act(() => button("Try again")!.click());
  await settle(() => button("Edit Amount: 1010") !== undefined);
  expect(
    edits.map(({ idempotencyKey, value, expectedVersion }) => [
      idempotencyKey,
      value,
      expectedVersion,
    ]),
  ).toEqual([
    [edits[0]!.idempotencyKey, 1010, 4],
    [edits[0]!.idempotencyKey, 1010, 4],
  ]);
  expect(host.querySelector('[role="status"]')!.textContent).toBe("Saved");
});

it("offers Undo only where the Collection's rules let a change be undone", async () => {
  await open(true);
  answers.push(
    () => jsonResponse({ ok: true, result: { saved: { version: 5, priorValue: 960 } } }),
    () => jsonResponse({ ok: true, result: { saved: { version: 6, priorValue: 1010 } } }),
  );
  await change("1010");
  await settle(() => button("Undo") !== undefined);
  act(() => button("Undo")!.click());
  await settle(() => button("Edit Amount: 960") !== undefined);
  expect(edits.map(({ value, expectedVersion }) => [value, expectedVersion])).toEqual([
    [1010, 4],
    [960, 5],
  ]);
  expect(edits[1]!.idempotencyKey).not.toBe(edits[0]!.idempotencyKey);
});
