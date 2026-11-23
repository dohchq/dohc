import { afterEach, expect, it } from "vitest";
import { APP_BACKEND_CATCH_UP_HEADER } from "@dohc/security-contract/app-backend";
import { id, startTestRelay } from "./serverCollectionsTestRelay";

// The requests one change costs between a syncing owner's computer and the
// server that holds the Collection, through the real routes over a socket.
// DOHC_TRIP_TIMES=<round trip ms> also prints how long each takes over a
// network with that round trip.
const roundTripMs = Number(process.env.DOHC_TRIP_TIMES ?? 0);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function ownerOverSocket(latencyMs = 0) {
  const relay = await startTestRelay();
  cleanups.push(() => relay.close());
  await relay.activate();
  return relay.computer({ latencyMs });
}

async function measure(run: () => Promise<unknown>, trips: string[], times = 20) {
  const requests = new Set<string>(),
    durations: number[] = [];
  for (let index = 0; index < times; index++) {
    const before = trips.length,
      started = performance.now();
    await run();
    durations.push(performance.now() - started);
    requests.add(JSON.stringify(trips.slice(before)));
  }
  durations.sort((a, b) => a - b);
  return {
    requests: [...requests].map((value) => JSON.parse(value) as string[]),
    medianMs: Math.round(durations[Math.floor(durations.length / 2)]! * 10) / 10,
  };
}

async function edits(latencyMs = 0) {
  const owner = await ownerOverSocket(latencyMs);
  await owner.write(id(5), { values: { [id(4)]: "First" } });
  await owner.read();
  let name = 0;
  // A record edit in a table: the change, then the table's read that shows it.
  const edit = await measure(async () => {
    await owner.write(id(7), { id: 1, name: `Name ${++name}` });
    expect(await owner.read()).toMatchObject({
      result: [{ id: 1, name: `Name ${name}` }],
      copy: { offline: false },
    });
  }, owner.trips);
  // An app operation: one change, with no read after it.
  const operation = await measure(
    () => owner.write(id(5), { values: { [id(4)]: "Added" } }),
    owner.trips,
  );
  return { edit, operation };
}

it("sends one request for a change on a syncing owner's computer, and the table shows it", async () => {
  const { edit, operation } = await edits();
  expect(edit.requests).toEqual([["POST /invoke"]]);
  expect(operation.requests).toEqual([["POST /invoke"]]);
}, 120_000);

it("shows a change whose journal the copy did not apply, in the read just after it", async () => {
  const owner = await ownerOverSocket();
  const rename = (name: string) => owner.write(id(7), { id: 1, name });
  // A read shows the kept copy at once, and the copy shows the change once an
  // update brings it in, which it says.
  const shows = async (name: string) => {
    for (;;) {
      const next = owner.updated(id(1));
      const { result } = await owner.read();
      if ((result as Array<{ name: string }>)[0]?.name === name) return;
      await next;
    }
  };
  await owner.write(id(5), { values: { [id(4)]: "First" } });
  await rename("a");
  await shows("a");

  // A server that leaves the journal out, as it does for one too large to carry.
  owner.intercept((headers, go) => {
    headers.delete(APP_BACKEND_CATCH_UP_HEADER);
    return go();
  });
  await rename("b");
  await shows("b");

  // The server commits the change, and its answer is lost.
  owner.intercept(async (_headers, go) => {
    await go();
    throw new TypeError("fetch failed");
  });
  await expect(rename("c")).rejects.toThrow("could not reach");
  await shows("c");

  // An earlier change's journal arrives after a later change went out.
  let reached!: () => void, release!: () => void;
  const committed = new Promise<void>((resolve) => (reached = resolve)),
    held = new Promise<void>((resolve) => (release = resolve));
  owner.intercept(async (_headers, go) => {
    const response = await go();
    reached();
    await held;
    return response;
  });
  const earlier = rename("d");
  await committed;
  owner.intercept((headers, go) => {
    headers.delete(APP_BACKEND_CATCH_UP_HEADER);
    return go();
  });
  await rename("e");
  release();
  await earlier;
  await shows("e");

  // An earlier change reaches the server after a later one has committed and confirmed.
  let entered!: () => void, send!: () => void;
  const waiting = new Promise<void>((resolve) => (entered = resolve)),
    sent = new Promise<void>((resolve) => (send = resolve));
  owner.intercept(async (headers, go) => {
    headers.delete(APP_BACKEND_CATCH_UP_HEADER);
    entered();
    await sent;
    return go();
  });
  const late = rename("f");
  await waiting;
  await rename("g");
  send();
  await late;
  await shows("f");
}, 60_000);

it.runIf(roundTripMs > 0)(
  "prints how long a change takes",
  async () => {
    console.log(JSON.stringify({ roundTripMs, ...(await edits(roundTripMs)) }));
  },
  300_000,
);
