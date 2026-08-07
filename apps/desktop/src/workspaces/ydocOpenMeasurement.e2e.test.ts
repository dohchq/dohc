import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import * as Y from "yjs";
import {
  YDOC_OPEN_DEADLINE_MS,
  YdocLiveAdapter,
  type EngineTransport,
  type Request,
  type Response,
} from "@dohc/workspace-engine-client";
import {
  EngineDaemonLifecycle,
  EngineWorkspaceSessions,
} from "@dohc/workspace-engine-client/daemon";
import { createWorkspaceEngineCapture } from "./workspaceEngineCapture";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import { createTestScratch } from "./testTemp";

// #616, AGENTS.md "measure limits that reject work". YDOC_OPEN_DEADLINE_MS
// rejects a `ydoc.open` that has not answered, so the only work it can reject
// is a healthy open — and the honest way to know what one costs is to run one
// against the daemon. The recorded table lives where the constant does
// (ydocLiveAdapter.ts). This suite re-measures a representative slice of it on
// whatever machine runs it, and fails when the bound stops clearing that slice.
//
// The slice, not the sweep: the table's deepest lineages take minutes to build
// at roughly one journalled append per daemon round trip, and the shape they
// establish is already visible at the size below. What the table records and
// this file cannot is how the cost grows; what this file adds is that it has
// not moved on the machine in front of you.

const engine = requireEngineBinaryOrSkip();
const WORKSPACE_ID = "ydoc-open-measurement";

// The widest healthy open of the recorded table, in ms. See the table in
// ydocLiveAdapter.ts for the machine, the build and every case.
// It is the resurrection of a lineage nothing settled: 10,000 real appends the
// open has to replay.
const RECORDED_WIDEST_HEALTHY_OPEN_MS = 121;

// The recorded table is one fast machine's debug build. A bound that applies on
// every machine dohc runs on has to clear it by more than measurement noise, so
// this is how much slower than the reference machine a healthy open may get
// before the bound starts rejecting it.
const SLOWEST_HEALTHY_MACHINE_FACTOR = 40;

// What a live measurement here may take. Looser than the factor above on
// purpose: this one runs beside every other suite in the repo, so it has to
// survive load it does not control, and it is a floor for the bound rather
// than the reason for its size.
const LIVE_MEASUREMENT_FACTOR = 8;

// One transport per measurement, and so one open per transport: `openMs` is
// undefined until that open answers, and a second one would be a harness bug
// rather than a sample to keep.
class TimingTransport implements EngineTransport {
  openMs: number | undefined;

  constructor(private readonly inner: EngineTransport) {}

  async sendRequest(request: Request): Promise<Response> {
    const startedAt = performance.now();
    try {
      return await this.inner.sendRequest(request);
    } finally {
      if (request.method === "ydoc.open") {
        this.openMs = performance.now() - startedAt;
      }
    }
  }

  onEvent(handler: Parameters<EngineTransport["onEvent"]>[0]): () => void {
    return this.inner.onEvent(handler);
  }

  requireOpenMs(): number {
    if (this.openMs === undefined) throw new Error("No ydoc.open was measured.");
    return this.openMs;
  }
}

function bodyText(doc: Y.Doc): Y.XmlText {
  const first = doc.getXmlFragment("body").get(0);
  if (!(first instanceof Y.XmlElement)) {
    throw new Error("The document body has no first block.");
  }
  const text = first.get(0);
  if (!(text instanceof Y.XmlText)) {
    throw new Error("The document's first block holds no text.");
  }
  return text;
}

it("keeps the bound clear of the recorded healthy range", () => {
  // MUTATION: tighten YDOC_OPEN_DEADLINE_MS below
  // RECORDED_WIDEST_HEALTHY_OPEN_MS * SLOWEST_HEALTHY_MACHINE_FACTOR and this
  // fails by name. It runs without a daemon on purpose: the measurement suite
  // below skips where none is built, and a bound nobody checks is how a limit
  // drifts back into the range it rejects.
  expect(YDOC_OPEN_DEADLINE_MS).toBeGreaterThanOrEqual(
    RECORDED_WIDEST_HEALTHY_OPEN_MS * SLOWEST_HEALTHY_MACHINE_FACTOR,
  );
});

it.skipIf(engine.missing)(
  "measures healthy ydoc.open against the real daemon and stays well inside the bound",
  async () => {
    const root = await createTestScratch("dohc-ydoc-open-measurement-");
    await mkdir(join(root, ".dohc", "engine"), { recursive: true });
    await writeFile(
      join(root, ".dohc", "engine", "SHADOW_CLONE"),
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "utf8",
    );
    const measured: { case: string; ms: number }[] = [];
    let lifecycle = new EngineDaemonLifecycle({
      command: engine.require(),
      maxRestarts: 0,
    });
    await lifecycle.start();
    let sessions = new EngineWorkspaceSessions(lifecycle);
    let capture = createWorkspaceEngineCapture({
      workspaceId: WORKSPACE_ID,
      rootPath: root,
      rustEngineSessions: sessions,
      daemonOwnsCapture: true,
    });
    try {
      // 47 KiB: just under the 48 KiB in-band cap the daemon refuses a seeded
      // open past (INBAND_CONTENT_CAP_BYTES), so this is the largest document
      // a first open can carry.
      const paragraph = `${"lorem ipsum dolor sit amet ".repeat(38)}\n\n`;
      const big = `# big\n\n${paragraph.repeat(
        Math.floor((47 * 1024) / paragraph.length) - 1,
      )}`;
      await writeFile(join(root, "big.md"), big, "utf8");
      await writeFile(join(root, "draft.md"), "draft\n\nseed paragraph\n", "utf8");
      capture.captureBatch([
        { path: "big.md", operation: "update" },
        { path: "draft.md", operation: "update" },
      ]);
      await capture.flush();
      const versionId = (await capture.listVersions()).activeVersionId;

      const measure = async (
        label: string,
        path: string,
        inspect?: (
          session: Awaited<ReturnType<YdocLiveAdapter["openSession"]>>,
        ) => Promise<void>,
      ): Promise<void> => {
        await sessions.run(
          { workspaceId: WORKSPACE_ID, rootPath: root },
          async (binding) => {
            const timing = new TimingTransport(binding.client as EngineTransport);
            const adapter = new YdocLiveAdapter(timing);
            const session = await adapter.openSession({
              workspace: binding.workspace,
              versionId,
              path,
              contentKind: "richdoc",
            });
            measured.push({ case: label, ms: timing.requireOpenMs() });
            await inspect?.(session);
            await session.close({ settle: true });
            adapter.dispose();
          },
        );
      };

      await measure("cold store, 47 KiB document", "big.md");
      await measure("warm store, 47 KiB document", "big.md");

      // A capture batch the daemon is still working through, so the open
      // competes with the workspace's own traffic rather than an idle daemon.
      const bulk = Array.from({ length: 40 }, (_, index) => ({
        path: `bulk-${index}.md`,
        operation: "update" as const,
      }));
      for (const item of bulk) {
        await writeFile(join(root, item.path), `${"x".repeat(32 * 1024)}\n`, "utf8");
      }
      capture.captureBatch(bulk);
      const busy = measure("busy capture chain, 47 KiB document", "big.md");
      await Promise.all([busy, capture.flush()]);

      // A lineage nothing settled: real typed appends, then the daemon dies
      // under them. The next open replays the journal instead of a compacted
      // snapshot — the resurrection an open pays for, and the widest healthy
      // case this bound has to clear.
      const appends = 800;
      await sessions.run(
        { workspaceId: WORKSPACE_ID, rootPath: root },
        async (binding) => {
          const adapter = new YdocLiveAdapter(binding.client as EngineTransport);
          const session = await adapter.openSession({
            workspace: binding.workspace,
            versionId,
            path: "draft.md",
            contentKind: "richdoc",
          });
          for (let index = 0; index < appends; index += 1) {
            await session.applyLocalEdit((doc) => {
              const text = bodyText(doc);
              text.insert(text.length, `w${index} `);
            });
          }
          adapter.dispose();
        },
      );
      await lifecycle.stop();
      lifecycle = new EngineDaemonLifecycle({
        command: engine.require(),
        maxRestarts: 0,
      });
      await lifecycle.start();
      sessions = new EngineWorkspaceSessions(lifecycle);
      capture = createWorkspaceEngineCapture({
        workspaceId: WORKSPACE_ID,
        rootPath: root,
        rustEngineSessions: sessions,
        daemonOwnsCapture: true,
      });
      await measure(
        `resurrected lineage, ${appends} unsettled appends`,
        "draft.md",
        async (session) => {
          // The typed text is really there: an open that answered an empty
          // document would be fast and would measure nothing.
          expect(bodyText(session.doc).length).toBeGreaterThan(appends * 3);
        },
      );
    } finally {
      // eslint-disable-next-line no-console
      console.log(
        `[measure] ydoc.open, bound ${YDOC_OPEN_DEADLINE_MS}ms:\n` +
          measured
            .map((entry) => `  ${entry.case}: ${entry.ms.toFixed(1)}ms`)
            .join("\n"),
      );
      await capture.stop().catch(() => undefined);
      await sessions.closeAll().catch(() => undefined);
      await lifecycle.stop().catch(() => undefined);
    }

    expect(measured).toHaveLength(4);
    for (const entry of measured) {
      // MUTATION: tighten the bound under the measured range and every case
      // named here fails with the number it measured.
      expect(
        entry.ms,
        `${entry.case} took ${entry.ms.toFixed(1)}ms against a ${YDOC_OPEN_DEADLINE_MS}ms bound`,
      ).toBeLessThan(YDOC_OPEN_DEADLINE_MS / LIVE_MEASUREMENT_FACTOR);
    }
  },
  300_000,
);
