import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createLocalDatasetHistoryReader } from "./localDatasetHistoryReader";

const workers = vi.hoisted(() => [] as Array<EventEmitter & { postMessage: ReturnType<typeof vi.fn>; ref: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> }>);
vi.mock("node:worker_threads", () => ({
  Worker: class extends EventEmitter {
    ref = vi.fn();
    unref = vi.fn();
    postMessage = vi.fn();
    terminate = vi.fn(async () => { this.emit("exit", 1); return 1; });
    constructor() { super(); workers.push(this); }
  },
}));
afterEach(() => { workers.length = 0; });

it.each(["error", "exit"])("replaces a worker after an in-flight %s and retries the next page", async event => {
  const reader = createLocalDatasetHistoryReader("store.sqlite", "workspace");
  try {
    const first = reader.read({});
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    const failed = expect(first).rejects.toThrow(event === "error" ? "worker crashed" : "Collection history is unavailable.");
    workers[0]!.emit(event, event === "error" ? new Error("worker crashed") : 1);
    await failed;
    const next = reader.read({ limit: 1 });
    void next.catch(() => undefined);
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    // A late exit from the failed worker must not discard its replacement.
    workers[0]!.emit("exit", 1);
    const result = { pages: [], transferred: [], sourceIds: [], sourceCount: 0 };
    workers[1]!.emit("message", { result });
    await expect(next).resolves.toEqual(result);
    const last = reader.read({});
    await vi.waitFor(() => expect(workers[1]!.postMessage).toHaveBeenCalledTimes(2));
    workers[1]!.emit("message", { result });
    await expect(last).resolves.toEqual(result);
    expect(workers).toHaveLength(2);
  } finally { await reader.close(); }
});

it("replaces a worker that exits between pages", async () => {
  const reader = createLocalDatasetHistoryReader("store.sqlite", "workspace");
  try {
    const first = reader.read({});
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    const result = { pages: [], transferred: [], sourceIds: [], sourceCount: 0 };
    workers[0]!.emit("message", { result });
    await first;
    workers[0]!.emit("exit", 0);
    const next = reader.read({});
    void next.catch(() => undefined);
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    workers[1]!.emit("message", { result });
    await expect(next).resolves.toEqual(result);
  } finally { await reader.close(); }
});
