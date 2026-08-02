import {
  createEngineClient,
  EngineDaemonLifecycle,
  type EngineDaemonClient,
} from "@dohc/workspace-engine-client/daemon";
import type { Request } from "@dohc/workspace-engine-client";
import { afterEach, describe, expect, it } from "vitest";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";

// The lifecycle unit suite drives a FAKE client. A fake cannot prove that the
// real daemon serves engine.ping, nor that the real client reports its answer
// as an answer — and the gap is not hypothetical. A first draft of the wedge
// detector passed every unit test and could never have fired in production,
// because EngineClient arms its own per-request deadline timer and that timer
// turned a wedged daemon's silence into a rejection the detector read as life.
// This suite is the counterweight: a real binary, the real transport.
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
  it.skipIf(engine.missing)(
    "answers every probe, so a healthy daemon is never killed",
    async () => {
      const probes: Array<{ request: Request; answered: boolean }> = [];
      const failures: Error[] = [];
      const lifecycle = new EngineDaemonLifecycle({
        command: engine.require(),
        pingIntervalMs: 100,
        // One unanswered probe kills at this configuration, and the bound is
        // 20x the interval: a real daemon that needed that long to answer a
        // probe touching nothing would itself be the news.
        pingExpiryMs: 2_000,
        maxPingExpiries: 1,
        launch: async (options): Promise<EngineDaemonClient> => {
          const client = await createEngineClient(options);
          return {
            sendRequest: async (request) => {
              if (request.method !== "engine.ping") {
                return await client.sendRequest(request);
              }
              const entry = { request, answered: false };
              probes.push(entry);
              const response = await client.sendRequest(request);
              entry.answered = true;
              return response;
            },
            cancelRequest: async (id) => await client.cancelRequest(id),
            onEvent: (handler) => client.onEvent(handler),
            onBlob: (handler) => client.onBlob(handler),
            close: () => client.close(),
            // Forwarded so this e2e drives the REAL kill path. A wrapper that
            // dropped it would send the supervisor down the close() fallback
            // and prove nothing about what a wedge kill reports.
            closeUnresponsive: () => client.closeUnresponsive(),
            inboundActivity: () => client.inboundActivity(),
            waitForExit: async () => await client.waitForExit(),
          };
        },
        onFailure: (error) => failures.push(error),
      });
      lifecycles.push(lifecycle);

      await lifecycle.start();
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      // Not vacuous: probes really went out over the real transport and the
      // real daemon really answered them. Counting the answered ones rather
      // than asserting on every probe leaves the newest one free to be in
      // flight at this instant.
      expect(probes.filter(({ answered }) => answered).length).toBeGreaterThanOrEqual(3);
      // And none of them carried a wire deadline, which is what keeps the
      // client's own timer out of the silence measurement.
      expect(
        probes.every(({ request }) => (request.deadlineMs ?? null) === null),
      ).toBe(true);
      expect(failures.map((error) => error.message)).toEqual([]);
      // Same daemon throughout: a kill would have ended or replaced it.
      expect(() => lifecycle.currentClient()).not.toThrow();
    },
    60_000,
  );
});
