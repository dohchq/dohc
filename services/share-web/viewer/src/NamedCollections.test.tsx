// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CollectionList, CollectionTable } from "./NamedCollections";
import { jsonResponse, settle, setControlValue } from "./testing";

const ITEM = "item-field",
  AMOUNT = "amount-field",
  NOTES = "notes-field",
  PAID = "paid-field";
type Edit = { idempotencyKey: string; value: unknown; expectedVersion: number };
type Row = { id: string; version: number; values: Record<string, unknown> };
let root: Root,
  host: HTMLElement,
  edits: Edit[],
  answers: Array<() => Response | Promise<Response>>,
  rows: Row[],
  rowRead: Promise<void> | null;

const hotel = (version: number, amount = 960): Row => ({
  id: "hotel",
  version,
  values: { [ITEM]: "Hotel", [AMOUNT]: amount, [NOTES]: "Late check-in\nRoom 4", [PAID]: null },
});

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
          { fieldId: NOTES, name: "Notes", type: "text", editable: true, reversible },
          { fieldId: PAID, name: "Paid", type: "checkbox", editable: true, reversible },
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
      if (operation === "collectionRecords") {
        if (args.recordId) await rowRead;
        return jsonResponse({
          ok: true,
          result: { status: "ready", rows, nextCursor: null, files: {} },
        });
      }
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
const control = () => host.querySelector<HTMLInputElement>("form input, form textarea")!;
const saved = (version: number, priorValue?: unknown) => () =>
  jsonResponse({ ok: true, result: { saved: { version, priorValue } } });
const refused = (code: string) => () =>
  jsonResponse({ ok: true, result: { refused: { code, message: "Refused." } } });
const offline = () => {
  throw new TypeError("fetch failed");
};

async function change(value: string, cell = "Edit Amount: 960") {
  act(() => button(cell)!.click());
  setControlValue(control(), value);
  act(() => host.querySelector("form")!.requestSubmit());
}

beforeEach(() => {
  edits = [];
  answers = [];
  rows = [hotel(4)];
  rowRead = null;
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
  answers.push(offline, saved(5));
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
  answers.push(saved(5, 960), saved(6, 1010));
  await change("1010");
  await settle(() => button("Undo") !== undefined);
  rows = [hotel(9, 1200)];
  act(() => button("Refresh")!.click());
  await settle(() => button("Edit Amount: 1200") !== undefined);
  act(() => button("Undo")!.click());
  await settle(() => edits.length === 2);
  expect(edits.map(({ value, expectedVersion }) => [value, expectedVersion])).toEqual([
    [1010, 4],
    [960, 5],
  ]);
  expect(edits[1]!.idempotencyKey).not.toBe(edits[0]!.idempotencyKey);
});

it("sends an uncertain Undo again exactly, even when the earlier value was empty", async () => {
  await open(true);
  answers.push(saved(5, null), offline, saved(6, true));
  act(() => button("Edit Paid: empty")!.click());
  act(() => control().click());
  act(() => host.querySelector("form")!.requestSubmit());
  await settle(() => button("Undo") !== undefined);
  act(() => button("Undo")!.click());
  await settle(() => button("Try again") !== undefined);
  act(() => button("Try again")!.click());
  await settle(() => edits.length === 3);
  expect(edits.map(({ value, idempotencyKey }) => [value, idempotencyKey])).toEqual([
    [true, edits[0]!.idempotencyKey],
    [null, edits[1]!.idempotencyKey],
    [null, edits[1]!.idempotencyKey],
  ]);
});

it("checks a change against the row as it was when editing began, even after Refresh", async () => {
  await open();
  answers.push(refused("stale_record"));
  act(() => button("Edit Amount: 960")!.click());
  rows = [hotel(7)];
  act(() => button("Refresh")!.click());
  await settle(() => host.querySelector("form") !== null);
  setControlValue(control(), "1010");
  expect(button("Refresh")!.disabled).toBe(true);
  act(() => host.querySelector("form")!.requestSubmit());
  await settle(() => host.textContent!.includes("This row changed since it loaded."));
  expect(edits.map(({ value, expectedVersion }) => [value, expectedVersion])).toEqual([[1010, 4]]);
  expect(control().value).toBe("1010");
});

it("keeps what the person typed while the current row loads", async () => {
  await open();
  answers.push(refused("stale_record"), saved(8));
  await change("1010");
  await settle(() => button("Load current row") !== undefined);
  let release!: () => void;
  rowRead = new Promise((resolve) => (release = resolve));
  rows = [hotel(7, 1100)];
  act(() => button("Load current row")!.click());
  setControlValue(control(), "1050");
  act(() => release());
  await settle(() => !host.textContent!.includes("This row changed"));
  expect(control().value).toBe("1050");
  act(() => host.querySelector("form")!.requestSubmit());
  await settle(() => edits.length === 2);
  expect(edits[1]).toMatchObject({ value: 1050, expectedVersion: 7 });
});

it("lets the table go on when the row being edited is gone after a reload", async () => {
  await open();
  answers.push(() => jsonResponse({ ok: true, result: { rulesChanged: true } }));
  await change("1010");
  rows = [{ id: "museum", version: 1, values: { [ITEM]: "Museum", [AMOUNT]: 120 } }];
  await settle(() => button("Edit Amount: 120") !== undefined);
  expect(button("Edit Amount: 120")!.disabled).toBe(false);
  expect(button("Refresh")!.disabled).toBe(false);
});

it("holds the value being saved until dohc answers", async () => {
  await open();
  let answer!: (response: Response) => void;
  answers.push(() => new Promise((resolve) => (answer = resolve)));
  await change("1010");
  await settle(() => edits.length === 1);
  setControlValue(control(), "1070");
  expect(control().value).toBe("1010");
  act(() => answer(jsonResponse({ ok: true, result: { saved: { version: 5 } } })));
  await settle(() => button("Edit Amount: 1010") !== undefined);
  expect(edits.map(({ value }) => value)).toEqual([1010]);
});

it("keeps line breaks in a text field, adds one with Shift+Enter, and saves with Enter", async () => {
  await open();
  answers.push(saved(5));
  act(() => button("Edit Notes: Late check-in\nRoom 4")!.click());
  setControlValue(control(), "Late check-in\nRoom 5");
  const press = (shiftKey: boolean) =>
    act(() => {
      control().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", shiftKey, bubbles: true }),
      );
    });
  press(true);
  expect(edits).toEqual([]);
  press(false);
  await settle(() => edits.length === 1);
  expect(edits[0]!.value).toBe("Late check-in\nRoom 5");
});

it("keeps what the person typed when the current row can't be loaded", async () => {
  await open();
  answers.push(refused("stale_record"));
  await change("1010");
  await settle(() => button("Load current row") !== undefined);
  let fail!: () => void;
  rowRead = new Promise((_resolve, reject) => (fail = () => reject(new Error("reset"))));
  act(() => button("Load current row")!.click());
  setControlValue(control(), "1050");
  act(() => fail());
  await settle(() => host.textContent!.includes("dohc could not load the current row"));
  expect(control().value).toBe("1050");
});

it("lists every Collection an invitation reaches, page by page", async () => {
  const cursors: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const { args } = JSON.parse(String(init?.body));
      cursors.push(args.cursor);
      return jsonResponse({
        ok: true,
        result: args.cursor
          ? { collections: [{ datasetId: "b", name: "Packing" }], nextCursor: null }
          : { collections: [{ datasetId: "a", name: "Trip budget" }], nextCursor: "a" },
      });
    }),
  );
  act(() =>
    root.render(
      <CollectionList grantId="grant" selected={null} disabled={false} onOpen={() => {}} />,
    ),
  );
  await settle(() => host.textContent!.includes("Packing"));
  expect(host.textContent).toContain("Trip budget");
  expect(cursors).toEqual([undefined, "a"]);
});
