import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const savedPage = z.object({ key: digest, value: z.unknown(), savedAtMs: z.number().int().nonnegative() }).strict();
const savedScope = z.object({ key: digest, localAuthority: digest, fingerprint: digest, pages: z.array(savedPage).max(512) }).strict();
const savedFile = z.object({ version: z.literal(1), owner: digest, scopes: z.array(savedScope).max(128) }).strict();
type Saved = z.infer<typeof savedFile>;
export type NamedDatasetPageCache = {
  begin(): Promise<number>;
  accept(fingerprint: string, epoch: number): Promise<void>;
  read(key: unknown): Promise<z.infer<typeof savedPage> | null>;
  put(key: unknown, value: unknown, fingerprint: string): Promise<number | null>;
  clear(): Promise<void>;
};

/** Recipient responses only. This file never contains a database, executable rules, or owner history. */
export function createNamedDatasetCacheRegistry(options: { directory(): string; maxBytes?: number; nowMs?: () => number }) {
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  const nowMs = options.nowMs ?? Date.now;
  let owner: string | null = null, state: Saved | null = null, loaded = false, closed = false;
  let pending: Promise<unknown> = Promise.resolve();
  const epochs = new Map<string, number>();
  const enqueue = <T>(work: () => Promise<T>) => { const result = pending.then(work, work); pending = result.catch(() => undefined); return result; };
  const path = async () => {
    const directory = resolve(options.directory());
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || resolve(await realpath(directory)) !== directory) throw Error("Saved Collection pages must remain in this device's profile.");
    // The queue owns all writes. A matching temporary file is left by an interrupted prior process.
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (/^pages\.json\.[0-9a-f-]{36}$/.test(entry.name)) {
        if (!entry.isFile() || entry.isSymbolicLink()) throw Error("Saved Collection page storage changed. Reconnect to the sharing server.");
        await rm(join(directory, entry.name));
      }
    }
    return join(directory, "pages.json");
  };
  async function persist() {
    const target = await path();
    if (!state || !state.scopes.length) { await rm(target, { force: true }); return; }
    const temporary = `${target}.${randomUUID()}`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }
  async function load() {
    if (loaded) return;
    const target = await path(), info = await lstat(target).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
    if (info) {
      if (!info.isFile() || info.isSymbolicLink()) throw Error("Saved Collection pages are unavailable. Reconnect to the sharing server.");
      try { if (info.size <= maxBytes) state = savedFile.parse(JSON.parse(await readFile(target, "utf8"))); } catch { state = null; }
      if (!state || state.owner !== owner) { state = null; await rm(target, { force: true }); }
    }
    loaded = true;
  }
  return {
    credentialsChanged(next: string | null) {
      if (owner === next && (next !== null || loaded)) return pending.then(() => undefined);
      const hadOwner = owner !== null;
      owner = next;
      for (const key of epochs.keys()) epochs.set(key, epochs.get(key)! + 1);
      return enqueue(async () => {
        if (hadOwner || loaded || next === null) { state = null; loaded = true; await persist(); }
      });
    },
    scope(input: { owner: string; binding: unknown; localAuthority?: unknown; assertCurrent(): void }): NamedDatasetPageCache {
      const key = hash(input.binding), localAuthority = hash(input.localAuthority ?? null);
      const current = () => { input.assertCurrent(); if (closed || owner !== input.owner) throw Error("Your server account changed. Reopen the shared workspace."); };
      const run = <T>(work: () => Promise<T>) => enqueue(async () => {
        current(); await load(); current();
        if (scope() && scope()!.localAuthority !== localAuthority) {
          epochs.set(key, epoch() + 1);
          state!.scopes = state!.scopes.filter(value => value.key !== key);
          await persist();
        }
        const result = await work(); current(); return result;
      });
      const epoch = () => epochs.get(key) ?? 0;
      const scope = () => state?.scopes.find(value => value.key === key);
      return {
        begin: () => run(async () => epoch()),
        accept: (fingerprint, started) => run(async () => {
          digest.parse(fingerprint);
          const existing = scope();
          if (existing?.fingerprint === fingerprint) return;
          if (started !== epoch()) throw Error("Collection access changed while loading. Refresh this view.");
          epochs.set(key, epoch() + 1);
          state ??= { version: 1, owner: input.owner, scopes: [] };
          state.scopes = state.scopes.filter(value => value.key !== key);
          if (state.scopes.length === 128) state.scopes.shift();
          state.scopes.push({ key, localAuthority, fingerprint, pages: [] });
          await persist();
        }),
        read: request => run(async () => {
          const entry = scope()?.pages.find(page => page.key === hash(request));
          return entry ? structuredClone(entry) : null;
        }),
        put: (request, value, fingerprint) => run(async () => {
          const selected = scope();
          if (!selected || selected.fingerprint !== fingerprint) throw Error("Collection access changed while saving. Refresh this view.");
          const page = { key: hash(request), value: structuredClone(value), savedAtMs: nowMs() };
          if (Buffer.byteLength(JSON.stringify(page)) > maxBytes / 2) return null;
          selected.pages = selected.pages.filter(value => value.key !== page.key);
          selected.pages.push(page);
          if (selected.pages.length > 512) selected.pages.shift();
          while (Buffer.byteLength(JSON.stringify(state)) > maxBytes) {
            const oldest = state!.scopes.filter(scope => scope.pages.length).sort((a, b) => a.pages[0]!.savedAtMs - b.pages[0]!.savedAtMs)[0];
            if (!oldest) break;
            oldest.pages.shift();
          }
          await persist();
          return page.savedAtMs;
        }),
        clear: () => run(async () => {
          epochs.set(key, epoch() + 1);
          if (state) state.scopes = state.scopes.filter(value => value.key !== key);
          await persist();
        }),
      };
    },
    async close() { closed = true; await pending; },
  };
}
