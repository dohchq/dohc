import { createEngineClient, type EngineDaemonLifecycle } from "@dohc/workspace-engine-client/daemon";
import { afterEach, describe, expect, it } from "vitest";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import { createRealDaemonLifecycle, REAL_DAEMON_TEST_TIMEOUT_MS } from "../testing/realDaemonWorkspaceSessions";

// The lifecycle unit suite drives a fake client. A fake cannot prove that the
// real daemon serves engine.ping, nor that the real client reports its answer
// as an answer — and the gap is not hypothetical. A first draft of the wedge
// detector passed every unit test and could never have fired in production,
// because EngineClient arms its own per-request deadline timer and that timer
// turned a wedged daemon's silence into a rejection the detector read as life.
// This suite is the counterweight: a real binary, the real transport.
const requestTimeoutMs = 2_000;
const engine = requireEngineBinaryOrSkip();
const lifecycles: EngineDaemonLifecycle[] = [];

afterEach(async () => {
  await Promise.all(
    lifecycles.splice(0).map(async (lifecycle) => {
      await lifecycle.stop().catch(() => undefined);
    }),
  );
});

describe("engine.ping against a real daemon", () => {
  it.skipIf(engine.missing)("drains queued startup replies after the host event loop stalls beyond the request deadline", async () => {
    const failures: Error[] = [];
    let complete!: () => void, refuse!: (error: Error) => void, stalled = false;
    const smoke = new Promise<void>((resolve,reject) => {complete=resolve;refuse=reject;});
    const lifecycle = createRealDaemonLifecycle({command:engine.require(),maxRestarts:0,requestTimeoutMs,
      onFailure(error) {failures.push(error);refuse(error);},
      launch:async options => {
        const client = await createEngineClient(options);
        return {
          sendRequest:async (request, signal, progress, cancelSignal) => {
            const pending = client.sendRequest(request, signal, progress, cancelSignal);
            if (!stalled && request.method === "workspace.open") {
              stalled = true;
              // Freeze only this process after the pipe write. The lifecycle sends
              // its request timeout as the daemon's deadline, so the real daemon
              // queues its reply inside it, and the freeze outlasts both.
              setImmediate(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,requestTimeoutMs + 1_000));
            }
            const response = await pending;
            if (request.method === "workspace.close") complete();
            return response;
          },
          onEvent:handler=>client.onEvent(handler),onBlob:handler=>client.onBlob(handler),
          close:()=>client.close(),closeUnresponsive:()=>{refuse(new Error("Healthy engine killed after host stall."));client.closeUnresponsive();},
          inboundActivity:()=>client.inboundActivity(),waitForExit:()=>client.waitForExit(),
        };
      }});
    lifecycles.push(lifecycle);
    await lifecycle.start();
    await smoke;
    expect(stalled).toBe(true);
    expect(failures).toEqual([]);
    await expect(lifecycle.currentClient().sendRequest({id:99,method:"engine.ping",params:{}})).resolves.toMatchObject({id:99});
  },REAL_DAEMON_TEST_TIMEOUT_MS);
});
