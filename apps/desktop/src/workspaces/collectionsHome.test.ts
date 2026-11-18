import { afterEach, expect, it } from "vitest";
import { APP_BACKEND_CATCH_UP_HEADER } from "@dohc/security-contract/app-backend";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import { collectionsServer, createServerHomeData } from "./collectionsHome";
import { id, startTestRelay, unanswered } from "./serverCollectionsTestRelay";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function relayWithCollection() {
  const relay = await startTestRelay();
  cleanups.push(() => relay.close());
  await relay.activate();
  return relay;
}

it.each([
  ["syncing", { remote: { serverUrl: "https://a.test", ownerUserId: "u" } }, "https://a.test"],
  ["paused", { pausedRemote: { serverUrl: "https://a.test", ownerUserId: "u" } }, "https://a.test"],
  ["with no server", {}, null],
  [
    "received as a share",
    { shareView: {}, remote: { serverUrl: "https://a.test", ownerUserId: "u" } },
    null,
  ],
])("a workspace %s keeps its Collections on %s", (_kind, entry, server) => {
  expect(
    collectionsServer(entry as Parameters<typeof collectionsServer>[0])?.serverUrl ?? null,
  ).toBe(server);
});

it("lets a second computer list, read and change a Collection on the workspace's server", async () => {
  const relay = await relayWithCollection();
  const first = await relay.computer(),
    second = await relay.computer();
  // A third computer adds the record: a read within 1 s of a computer's own
  // change shows that computer's copy without asking the server.
  await (await relay.computer()).write(id(5), { values: { [id(4)]: "First" } });
  expect(await first.read()).toMatchObject({ result: [{ id: 1, name: "First" }] });

  expect((await second.data.list({})).datasets.map((dataset) => dataset.datasetId)).toEqual([
    id(1),
  ]);
  expect(await second.read()).toMatchObject({ result: [{ id: 1, name: "First" }] });
  await second.write(id(7), { id: 1, name: "Renamed" });
  // The first computer shows its copy at once, then the copy comes up to date.
  const updated = first.updated(id(1));
  await first.read();
  await updated;
  expect(await first.read()).toMatchObject({ result: [{ id: 1, name: "Renamed" }] });
}, 60_000);

it("offline, lists and reads what this computer kept, and refuses a change at once without applying it", async () => {
  const relay = await relayWithCollection();
  const computer = await relay.computer();
  // Another computer makes the change, so this one's read asks the server.
  await (await relay.computer()).write(id(5), { values: { [id(4)]: "First" } });
  await computer.data.list({});
  await computer.read();

  computer.offline(true);
  expect((await computer.data.list({})).datasets.map((dataset) => dataset.datasetId)).toEqual([
    id(1),
  ]);
  // The read shows the copy at once, then finds out the server is out of reach.
  const found = computer.updated(id(1));
  expect(await computer.read()).toMatchObject({ result: [{ id: 1, name: "First" }] });
  await found;
  expect(await computer.read()).toMatchObject({
    result: [{ id: 1, name: "First" }],
    copy: { offline: true },
  });
  const started = performance.now();
  // A refusal tells the window that nothing ran, so it shows the true value and keeps nothing to send later.
  const refused = expect.objectContaining({
    code: "operation_refused",
    message: `dohc didn't save this change. This Collection is read-only until ${relay.host} is reachable.`,
    refusal: expect.objectContaining({ code: "offline" }),
  });
  await expect(computer.write(id(7), { id: 1, name: "Offline" })).rejects.toEqual(refused);
  expect(performance.now() - started).toBeLessThan(1000);
  // The same, once this computer's copy knows it is offline.
  await expect(computer.write(id(7), { id: 1, name: "Offline" })).rejects.toEqual(refused);

  const back = computer.updated(id(1));
  computer.offline(false);
  await computer.read();
  await back;
  expect(await computer.read()).toMatchObject({
    result: [{ id: 1, name: "First" }],
    copy: { offline: false },
  });
}, 60_000);

it("signed out, lists and reads what this computer kept, read-only, and refuses a change at once", async () => {
  const relay = await relayWithCollection();
  const computer = await relay.computer();
  await computer.write(id(5), { values: { [id(4)]: "First" } });
  await computer.data.list({});
  await computer.read();

  const signedOut = await computer.signOut();
  expect((await signedOut.data.list({})).datasets.map((dataset) => dataset.datasetId)).toEqual([
    id(1),
  ]);
  expect(await signedOut.read()).toMatchObject({
    result: [{ id: 1, name: "First" }],
    copy: { offline: true, signedOut: true },
  });
  const started = performance.now();
  await expect(signedOut.write(id(7), { id: 1, name: "Signed out" })).rejects.toEqual(
    expect.objectContaining({
      code: "operation_refused",
      message:
        "dohc didn't save this change. This Collection is read-only until you connect your server.",
      refusal: expect.objectContaining({ code: "offline" }),
    }),
  );
  expect(performance.now() - started).toBeLessThan(1000);
  // What the copy does not hold needs the server, which a signed-out read never asks.
  await expect(signedOut.data.history({ datasetId: id(1) })).rejects.toThrow(
    "Sign in to your server first.",
  );
  expect(await signedOut.read()).toMatchObject({ result: [{ id: 1, name: "First" }] });
}, 60_000);

it("signed out on a computer that kept nothing, says to sign in, as before", async () => {
  const relay = await relayWithCollection();
  const signedOut = await (await relay.computer()).signOut();
  await expect(signedOut.data.list({})).rejects.toThrow("Sign in to your server first.");
}, 60_000);

type Computer = Awaited<ReturnType<Awaited<ReturnType<typeof startTestRelay>>["computer"]>>;

/** Waits until a read shows the first record named `name`, one copy update at a time. */
async function shows(computer: Computer, name: string) {
  for (;;) {
    const next = computer.updated(id(1));
    const { result } = await computer.read();
    if ((result as Array<{ name: string }>)[0]?.name === name) return;
    await next;
  }
}

/** Fails when `work` takes longer than `ms`: a read that waits on the network. */
function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`It waited more than ${ms} ms.`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

it.each([
  ["down behind a front that answers 502", "error"],
  ["not answering", "silent"],
  // A refused connection takes about 2 s on Windows.
  ["refusing the connection", "refused"],
] as const)(
  "with the server %s, lists, opens and reads the kept copy at once on each computer that has one",
  async (_kind, reach) => {
    const relay = await relayWithCollection();
    const first = await relay.computer(),
      second = await relay.computer();
    await first.write(id(5), { values: { [id(4)]: "First" } });
    for (const computer of [first, second]) {
      await computer.data.list({});
      await computer.open();
      await computer.read();
    }

    for (const computer of [first, second]) {
      computer.server(reach, { refusedAfterMs: 2000, limitMs: 15_000 });
      expect(
        (await within(500, computer.data.list({}))).datasets.map((dataset) => dataset.datasetId),
      ).toEqual([id(1)]);
      expect(await within(500, computer.open())).toMatchObject({ dataset: { datasetId: id(1) } });
      expect(await within(500, computer.read())).toMatchObject({
        result: [{ id: 1, name: "First" }],
      });
    }
  },
  60_000,
);

it("waits for the server only to open a Collection this computer has no copy of, once", async () => {
  const relay = await relayWithCollection();
  const computer = await relay.computer();
  await computer.data.list({});
  computer.server("silent", { limitMs: 2000 });
  const started = performance.now();
  await expect(computer.open()).rejects.toThrow(
    `This Collection needs ${relay.host}, which dohc can't reach.`,
  );
  // One limit, not one for each request in turn. The rest leaves room for a
  // loaded test run.
  expect(performance.now() - started).toBeLessThan(3800);
}, 60_000);

it("brings an open Collection up to date by itself: another computer's change, the server going and coming back", async () => {
  const relay = await relayWithCollection();
  const computer = await relay.computer({ retryMs: 50 }),
    other = await relay.computer();
  await other.write(id(5), { values: { [id(4)]: "First" } });
  await computer.open();
  await computer.read();

  // Another computer's change: the read shows the kept copy, then the copy says it changed.
  await other.write(id(7), { id: 1, name: "Renamed" });
  let changed = computer.updated(id(1));
  await computer.read();
  await changed;
  expect(await computer.read()).toMatchObject({ result: [{ id: 1, name: "Renamed" }] });

  // The server goes: the copy finds out and says so.
  computer.server("error");
  changed = computer.updated(id(1));
  await computer.open();
  await changed;
  expect(await computer.open()).toMatchObject({ copy: { offline: true } });

  // It comes back: the copy finds out without anyone asking.
  changed = computer.updated(id(1));
  computer.server("online");
  await changed;
  expect(await computer.open()).toMatchObject({ copy: { offline: false } });
}, 60_000);

// A server with one Collection more than a page holds, and a list saved in memory.
function fiftyOneCollections() {
  const all: DatasetDescription[] = Array.from({ length: 51 }, (_, n) => ({
    datasetId: `00000000-0000-4000-8000-${String(n + 1).padStart(12, "0")}`,
    name: `Collection ${n + 1}`,
    revision: 1,
    revisionSha256: "a".repeat(64),
    tables: [],
    operations: [],
  }));
  let kept: unknown;
  const data = createServerHomeData({
    host: "relay.test",
    list: async ({ after, limit = 50 }) => {
      const rest = all.filter((dataset) => dataset.datasetId > (after ?? ""));
      return {
        datasets: rest.slice(0, limit),
        nextCursor: rest.length > limit ? rest[limit - 1]!.datasetId : null,
      };
    },
    copy: () => Promise.reject(Error("No Collection opens here.")),
    saved: {
      read: async () => kept ?? Promise.reject(Error("Nothing saved.")),
      update: async (change) => {
        kept = change(kept) ?? kept;
      },
    },
  });
  const listed = async () => {
    const ids: string[] = [];
    for (let after: string | null | undefined; after !== null;) {
      const page = await data.list({ limit: 50, ...(after ? { after } : {}) });
      ids.push(...page.datasets.map((dataset) => dataset.datasetId));
      after = page.nextCursor;
    }
    return ids;
  };
  return { ids: all.map((dataset) => dataset.datasetId), data, listed };
}
it("lists every Collection past the first page from the list it saved", async () => {
  const { ids, data, listed } = fiftyOneCollections();
  // The first visit reads the first page, and the list is saved.
  expect((await data.list({ limit: 50 })).nextCursor).toBe(ids[49]);
  // A later visit answers from the saved list, and still reaches the last Collection.
  expect(await listed()).toEqual(ids);
});
it("shows the next page at once when the list saved only the first", async () => {
  const { ids, listed } = fiftyOneCollections();
  expect(await listed()).toEqual(ids);
});

it("shows a Collection another computer created once the list is brought up to date", async () => {
  const relay = await startTestRelay();
  cleanups.push(() => relay.close());
  const computer = await relay.computer();
  expect((await computer.data.list({})).datasets).toEqual([]);
  await relay.activate();
  const changed = computer.updated("list");
  await computer.data.list({});
  await changed;
  expect((await computer.data.list({})).datasets.map((dataset) => dataset.datasetId)).toEqual([
    id(1),
  ]);
}, 60_000);

it("reads the kept copy at once while it brings in the server's history, and says when that stalls", async () => {
  const relay = await relayWithCollection();
  const computer = await relay.computer({ slowMs: 200 }),
    other = await relay.computer();
  await other.write(id(5), { values: { [id(4)]: "First" } });
  await computer.open();
  await computer.read();
  await other.write(id(7), { id: 1, name: "Renamed" });
  // The server says where its history ends, then sends none of it.
  let asked!: () => void;
  const historyAsked = new Promise<void>((resolve) => (asked = resolve));
  computer.around((path, go, signal) => {
    if (!path.endsWith("/replica/page")) return go();
    asked();
    return unanswered(15_000, signal);
  });
  const stalled = computer.updated(id(1));
  await computer.read();
  await historyAsked;
  expect(await within(500, computer.read())).toMatchObject({
    result: [{ id: 1, name: "First" }],
  });
  await within(1000, stalled);
  expect(await computer.open()).toMatchObject({ copy: { offline: true } });
}, 60_000);

it("stays changeable when this computer's own change overtakes an update", async () => {
  const relay = await relayWithCollection();
  const computer = await relay.computer(),
    other = await relay.computer();
  await other.write(id(5), { values: { [id(4)]: "First" } });
  await computer.open();
  await computer.read();
  await other.write(id(7), { id: 1, name: "Renamed" });
  // While the update brings in the history, this computer makes a change,
  // whose answer takes the copy past the head the update captured.
  let overtaken = false;
  computer.around(async (path, go) => {
    if (path.endsWith("/replica/page") && !overtaken) {
      overtaken = true;
      await computer.write(id(7), { id: 1, name: "Mine" });
    }
    return go();
  });
  const done = computer.updated(id(1));
  await computer.read();
  await done;
  expect(await computer.read()).toMatchObject({
    result: [{ id: 1, name: "Mine" }],
    copy: { offline: false },
  });
}, 60_000);

it("reads the kept copy at once when this computer's own change lands partway into the history an update brought in", async () => {
  const relay = await relayWithCollection();
  const computer = await relay.computer(),
    other = await relay.computer();
  await other.write(id(5), { values: { [id(4)]: "First" } });
  await computer.open();
  await computer.read();
  await other.write(id(7), { id: 1, name: "a" });
  // This computer's change commits after that one, and its answer is held.
  let committed!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => (committed = resolve)),
    held = new Promise<void>((resolve) => (release = resolve));
  computer.intercept(async (_headers, go) => {
    const response = await go();
    committed();
    await held;
    return response;
  });
  const mine = computer.write(id(7), { id: 1, name: "b" });
  await reached;
  await other.write(id(7), { id: 1, name: "c" });
  // The update brings in all three records, then the held answer takes the
  // copy to the second, and the server stops sending history.
  let staged = false,
    stall!: () => void;
  const stalled = new Promise<void>((resolve) => (stall = resolve));
  computer.around(async (path, go, signal) => {
    if (!path.endsWith("/replica/page")) return go();
    if (staged) {
      stall();
      return unanswered(15_000, signal);
    }
    staged = true;
    const response = await go();
    release();
    await mine;
    return response;
  });
  await computer.read();
  const current = shows(computer, "c");
  // Reads stay at once whether or not the update still asks the server for history.
  await within(2000, Promise.race([current, stalled]));
  expect(await within(500, computer.read())).toMatchObject({ result: [{ id: 1 }] });
  await within(2000, current);
}, 60_000);

it("brings the copy up to date after a description read from it", async () => {
  const relay = await relayWithCollection();
  const computer = await relay.computer(),
    other = await relay.computer();
  await other.write(id(5), { values: { [id(4)]: "First" } });
  await computer.open();
  await shows(computer, "First");
  await other.write(id(7), { id: 1, name: "Renamed" });
  const changed = computer.updated(id(1));
  await computer.data.describe(id(1));
  await within(2000, changed);
}, 60_000);

it("says the copy changed after this computer's own change, as one an agent makes", async () => {
  const relay = await relayWithCollection();
  const computer = await relay.computer();
  await computer.write(id(5), { values: { [id(4)]: "First" } });
  await shows(computer, "First");
  const changed = computer.updated(id(1));
  await computer.write(id(7), { id: 1, name: "Renamed" });
  await within(1000, changed);
}, 60_000);

it("waits for the server at most once for a first open whose history stops coming", async () => {
  const relay = await relayWithCollection();
  await (await relay.computer()).write(id(5), { values: { [id(4)]: "First" } });
  const computer = await relay.computer({ firstOpenMs: 1000 });
  await computer.data.list({});
  computer.around((path, go, signal) =>
    path.endsWith("/replica/page") ? unanswered(15_000, signal) : go(),
  );
  await expect(within(1500, computer.read())).rejects.toThrow(
    `This Collection needs ${relay.host}, which dohc can't reach.`,
  );
}, 60_000);

it("reads the kept copy at once after a change whose records it does not hold yet", async () => {
  const relay = await relayWithCollection();
  const computer = await relay.computer();
  await computer.write(id(5), { values: { [id(4)]: "First" } });
  await computer.read();
  // The server takes the change and leaves its records out, then stops answering.
  computer.intercept(async (headers, go) => {
    headers.delete(APP_BACKEND_CATCH_UP_HEADER);
    const response = await go();
    computer.server("silent", { limitMs: 15_000 });
    return response;
  });
  await computer.write(id(7), { id: 1, name: "Renamed" });
  expect(await within(500, computer.read())).toMatchObject({
    result: [{ id: 1, name: "First" }],
  });
}, 60_000);

it("says the copy may not be current soon after the server stops answering, not at the limit", async () => {
  const relay = await relayWithCollection();
  const computer = await relay.computer({ slowMs: 200 });
  await (await relay.computer()).write(id(5), { values: { [id(4)]: "First" } });
  await computer.open();
  computer.server("silent", { limitMs: 15_000 });
  const found = computer.updated(id(1));
  await computer.open();
  await within(1000, found);
  expect(await computer.open()).toMatchObject({ copy: { offline: true } });
}, 60_000);

it("waits for the server at most once for the whole first open, however many requests it takes", async () => {
  const relay = await relayWithCollection();
  const computer = await relay.computer({ firstOpenMs: 1000 });
  await computer.data.list({});
  // The server answers where its history ends late, then never sends the Collection.
  computer.around(async (path, go, signal) => {
    if (path.endsWith("/replica/capture")) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return go();
    }
    return path.endsWith("/replica/blob") ? unanswered(800, signal) : go();
  });
  const started = performance.now();
  await expect(computer.open()).rejects.toThrow(
    `This Collection needs ${relay.host}, which dohc can't reach.`,
  );
  expect(performance.now() - started).toBeLessThan(1250);
}, 60_000);

it("says the copy may not be current while the server answers with an error instead of its records", async () => {
  const relay = await relayWithCollection();
  const computer = await relay.computer({ retryMs: 50 }),
    other = await relay.computer();
  await other.write(id(5), { values: { [id(4)]: "First" } });
  await computer.open();
  await computer.read();
  let failing = true;
  computer.around((path, go) =>
    failing && path.endsWith("/replica/capture")
      ? Promise.resolve(new Response("{}", { status: 500 }))
      : go(),
  );
  await other.write(id(7), { id: 1, name: "Renamed" });
  let changed = computer.updated(id(1));
  await computer.open();
  await within(5000, changed);
  expect(await computer.open()).toMatchObject({ copy: { offline: true } });

  // It asks again by itself, and shows the change once the server sends it.
  changed = computer.updated(id(1));
  failing = false;
  await within(5000, changed);
  expect(await computer.read()).toMatchObject({
    result: [{ id: 1, name: "Renamed" }],
    copy: { offline: false },
  });
}, 60_000);

it("gives up on a change the server does not answer at the limit, after one request", async () => {
  const relay = await relayWithCollection();
  const computer = await relay.computer();
  await computer.open();
  computer.server("silent", { limitMs: 400 });
  const started = performance.now();
  await expect(computer.write(id(7), { id: 1, name: "Late" })).rejects.toThrow(
    `This Collection needs ${relay.host}, which dohc can't reach.`,
  );
  expect(performance.now() - started).toBeLessThan(700);
}, 60_000);

it("offline on a computer that never listed them, says which server has the Collections", async () => {
  const relay = await relayWithCollection();
  const computer = await relay.computer();
  computer.offline(true);
  await expect(computer.data.list({})).rejects.toThrow(
    `This workspace's Collections are on ${relay.host}, which dohc can't reach.`,
  );
}, 60_000);
