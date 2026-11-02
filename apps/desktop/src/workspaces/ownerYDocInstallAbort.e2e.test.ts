import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { EngineClient } from "@dohc/workspace-engine-client/daemon";
import { OwnerKnownRefusals } from "@dohc/workspace-engine-client/owner-ydoc-drainer";
import { buildRelay } from "../../../../services/sync-relay/scripts/build.mjs";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import { openLiveMoveFixture } from "../testing/liveMoveFixture";
import { runNativeOwnerDeliveryPass } from "./nativeOwnerDelivery";

const engine = requireEngineBinaryOrSkip();

let relayBuildDirectory: string;
let compiledRelayMain: string;

beforeAll(async () => {
  if (engine.missing) return;
  const output = fileURLToPath(new URL("../../../../services/sync-relay/.output/", import.meta.url));
  await mkdir(output, { recursive: true });
  relayBuildDirectory = await mkdtemp(join(output, "owner-install-abort-"));
  await buildRelay(relayBuildDirectory);
  compiledRelayMain = join(relayBuildDirectory, "main.js");
}, 30_000);

afterAll(async () => {
  if (relayBuildDirectory) await rm(relayBuildDirectory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
}, 30_000);

type Install = EngineClient["ownerYDocApplyInitialSync"];

// The real client, except that it counts enrollments, records each install's
// cursor and the cursors it reads, and lets the test take over the install.
function observedClient(real: EngineClient, install?: (commit: () => ReturnType<Install>) => ReturnType<Install>) {
  const calls = { enroll: 0, installs: [] as number[], readStates: [] as number[] };
  const enroll: EngineClient["ownerYDocEnroll"] = (...args) => { calls.enroll++; return real.ownerYDocEnroll(...args); };
  const applyInitialSync: Install = (request, input, signal) => {
    calls.installs.push(input.journalCursor);
    const commit = () => real.ownerYDocApplyInitialSync(request, input, signal);
    return install ? install(commit) : commit();
  };
  const readState: EngineClient["ownerYDocReadState"] = async (...args) => {
    const state = await real.ownerYDocReadState(...args);
    calls.readStates.push(state.acceptedCursor);
    return state;
  };
  const replaced = new Map<PropertyKey, unknown>([["ownerYDocEnroll", enroll], ["ownerYDocApplyInitialSync", applyInitialSync],
    ["ownerYDocReadState", readState]]);
  const client = new Proxy(real, {
    get(target, property) {
      if (replaced.has(property)) return replaced.get(property);
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { client, calls };
}

// #3089: the move guard's deadline can abandon an owner sync. Whether or not
// the native install committed, the durable accepted state stays one matched
// pair, and the next pass starts from that pair. The owner here is already
// bound, so these cases can't enroll; T7's unbound peer covers that.
it.skipIf(engine.missing).each([
  { name: "abort before the native call", commit: false },
  { name: "a committed install whose answer is abandoned", commit: true },
])("an abandoned owner sync leaves a matched accepted state ($name)", async ({ commit }) => {
  const fixture = await openLiveMoveFixture({ workspaceId: `owner-install-abort-${commit ? "after" : "before"}`, compiledRelayMain,
    engineExecutable: engine.require(), pages: ["page"] });
  try {
    const owner = fixture.ownerEngine;
    const document = fixture.ownerDocument("page");
    const pass = (client: EngineClient, signal: AbortSignal) => owner.sessions.run(owner.workspace, ({ workspace }) =>
      runNativeOwnerDeliveryPass({ client, workspaceHandle: workspace, document, config: fixture.ownerConfig(document),
        refusals: new OwnerKnownRefusals(), signal, bearer: fixture.relayConnection.token, accountId: fixture.workspaceId,
        assertCurrent() {}, observedOnly: true }));
    const old = fixture.ownerAccepted("page");
    const cursor = await fixture.edit("page", " abandoned");
    expect(cursor).toBeGreaterThan(old.cursor);

    const controller = new AbortController();
    const abandoned = observedClient(owner.nativeClient(), async install => {
      if (commit) await install();
      controller.abort();
      throw controller.signal.reason;
    });
    await pass(abandoned.client, controller.signal).catch(() => undefined);
    expect(abandoned.calls.installs).toHaveLength(1);
    const installed = abandoned.calls.installs[0]!;
    expect(installed).toBeGreaterThanOrEqual(cursor);
    // Each case lands on its own side: an install that threw before it
    // committed would leave the old pair and fail the committed case.
    const after = fixture.ownerAccepted("page");
    const pair = JSON.stringify({ old, after, installed });
    expect(after.cursor, pair).toBe(commit ? installed : old.cursor);
    expect(after.digest === old.digest, pair).toBe(!commit);
    expect(abandoned.calls.enroll).toBe(0);

    // The next pass reads the durable state again and starts from it.
    const next = observedClient(owner.nativeClient());
    expect(["empty", "acknowledged"]).toContain(await pass(next.client, AbortSignal.timeout(60_000)));
    expect(next.calls.readStates[0]).toBe(after.cursor);
    expect(next.calls.enroll).toBe(0);
    expect(fixture.ownerAccepted("page").cursor).toBeGreaterThanOrEqual(cursor);
  } finally {
    await fixture.close();
  }
}, 300_000);
