/**
 * One live plugin pipeline per workspace, with disposal serialized against
 * creation.
 *
 * A workspace switch A -> B -> A can reach ensureWorkspacePipeline while A's
 * own teardown is still running: dispose() stops the host, drains the job
 * queues, and settles the discovery tail, all of which take real time. The
 * map entry is gone the moment teardown starts, so without the disposal
 * promise a second pipeline is created over the same userData snapshot and
 * bundle roots while the first one is still writing them (#779 round 11 A3).
 */
export async function ensureWorkspacePipeline<T>(input: {
  live: Map<string, T>;
  disposals: Map<string, Promise<void>>;
  workspaceId: string;
  create: () => T;
  start: (pipeline: T) => Promise<void>;
  dispose: (pipeline: T) => Promise<void>;
}): Promise<T> {
  const { live, disposals } = input;
  for (;;) {
    const existing = live.get(input.workspaceId);
    if (existing) {
      // start() memoizes its own promise, so a concurrent caller that lands
      // here while startInternal() is still running must still wait for it —
      // otherwise it can observe an empty pipeline.list() and report "no
      // plugins" with no retry (CodeRabbit #779 R5).
      await input.start(existing);
      return existing;
    }
    const disposal = disposals.get(input.workspaceId);
    if (!disposal) break;
    await disposal.catch(() => undefined);
  }

  const pipeline = input.create();
  live.set(input.workspaceId, pipeline);
  try {
    await input.start(pipeline);
    if (live.get(input.workspaceId) !== pipeline) {
      throw new Error("Plugin pipeline closed while the workspace was opening.");
    }
    return pipeline;
  } catch (error) {
    if (live.get(input.workspaceId) === pipeline) {
      live.delete(input.workspaceId);
    }
    // Registered like any other teardown: a retry landing while this failed
    // pipeline still drains would otherwise construct a second one over the
    // same userData roots — the exact overlap this module exists to close.
    await trackDisposal(
      disposals,
      input.workspaceId,
      input.dispose(pipeline).catch(() => undefined),
    );
    throw error;
  }
}

/**
 * Publishes a teardown as this workspace's disposal for as long as it runs, so
 * ensureWorkspacePipeline waits for it before creating the next pipeline.
 */
async function trackDisposal(
  disposals: Map<string, Promise<void>>,
  workspaceId: string,
  disposal: Promise<void>,
): Promise<void> {
  disposals.set(workspaceId, disposal);
  try {
    await disposal;
  } finally {
    if (disposals.get(workspaceId) === disposal) {
      disposals.delete(workspaceId);
    }
  }
}

export async function disposeWorkspacePipeline<T>(input: {
  live: Map<string, T>;
  disposals: Map<string, Promise<void>>;
  workspaceId: string;
  dispose: (pipeline: T) => Promise<void>;
}): Promise<void> {
  const { live, disposals } = input;
  const pipeline = live.get(input.workspaceId);
  if (!pipeline) return;
  live.delete(input.workspaceId);
  await trackDisposal(disposals, input.workspaceId, input.dispose(pipeline));
}
