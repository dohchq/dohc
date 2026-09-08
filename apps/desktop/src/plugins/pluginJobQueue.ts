interface QueuedJob {
  sourceRefresh: boolean;
  run: () => Promise<void>;
}

interface PluginJobQueue {
  jobs: QueuedJob[];
  sourceRefreshQueued: boolean;
  draining: Promise<void> | null;
}

export class PluginJobQueues {
  private readonly queues = new Map<string, PluginJobQueue>();

  constructor(
    private readonly onSourceRefreshFailure: (pluginId: string, error: unknown) => void,
  ) {}

  enqueueActionValue<T>(pluginId: string, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolveResult, rejectResult) => {
      const queue = this.queueFor(pluginId);
      queue.jobs.push({
        sourceRefresh: false,
        run: async () => {
          try {
            resolveResult(await run());
          } catch (error) {
            rejectResult(error);
          }
        },
      });
      this.drain(pluginId, queue);
    });
  }

  enqueueSourceRefresh(
    pluginId: string,
    prepare: () => () => Promise<void>,
  ): void {
    const queue = this.queueFor(pluginId);
    if (queue.sourceRefreshQueued) return;
    queue.sourceRefreshQueued = true;
    const run = prepare();
    queue.jobs.push({
      sourceRefresh: true,
      run: async () => {
        queue.sourceRefreshQueued = false;
        await run();
      },
    });
    this.drain(pluginId, queue);
  }

  waitForCurrentJobs(): Promise<void[]> {
    return Promise.all(
      [...this.queues.values()]
        .map((queue) => queue.draining)
        .filter((draining): draining is Promise<void> => draining !== null),
    );
  }

  private queueFor(pluginId: string): PluginJobQueue {
    const existing = this.queues.get(pluginId);
    if (existing) return existing;
    const queue: PluginJobQueue = {
      jobs: [],
      sourceRefreshQueued: false,
      draining: null,
    };
    this.queues.set(pluginId, queue);
    return queue;
  }

  private drain(pluginId: string, queue: PluginJobQueue): void {
    if (queue.draining) return;
    queue.draining = (async () => {
      while (queue.jobs.length > 0) {
        const job = queue.jobs.shift();
        if (!job) continue;
        try {
          await job.run();
        } catch (error) {
          if (job.sourceRefresh) {
            this.onSourceRefreshFailure(pluginId, error);
          }
        }
      }
    })().finally(() => {
      queue.draining = null;
      if (queue.jobs.length > 0) {
        this.drain(pluginId, queue);
      } else if (this.queues.get(pluginId) === queue) {
        this.queues.delete(pluginId);
      }
    });
  }
}
