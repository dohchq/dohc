import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mediaTypeForPath } from "@dohc/workspace-fs";
import type { FetchLike } from "./cloudSync";
import { createMergeSync, type MergeSync } from "./cloudSync";
import { nativeTmpdir } from "./testTemp";

type RemoteEntry = {
  id: string;
  kind: string;
  contentType: string;
  revision: number;
  body: string;
};

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick<T>(rng: () => number, values: T[]): T {
  return values[Math.floor(rng() * values.length)]!;
}

function fakeServer() {
  const files = new Map<string, RemoteEntry>();
  const seen: { appliedOps: unknown[][] } = { appliedOps: [] };

  function contentTypeFor(path: string) {
    return mediaTypeForPath(path);
  }

  function set(path: string, body: string, contentType = contentTypeFor(path)) {
    const prior = files.get(path);
    files.set(path, {
      id: prior?.id ?? `id-${path}`,
      kind: "atom",
      contentType,
      revision: (prior?.revision ?? 0) + 1,
      body,
    });
  }

  function fileSummary(path: string) {
    const file = files.get(path)!;
    return {
      id: file.id,
      path,
      kind: file.kind,
      contentType: file.contentType,
      revision: String(file.revision),
    };
  }

  function apply(op: Record<string, unknown>): { ok: boolean; error?: string; file?: unknown } {
    const path = String(op.path ?? "");
    const existing = files.get(path);
    if (op.op === "create") {
      if (existing) return { ok: false, error: "File path already exists" };
      set(path, String(op.body ?? ""), String(op.mediaType ?? contentTypeFor(path)));
      return { ok: true, file: fileSummary(path) };
    }
    if (op.op === "update") {
      if (!existing) return { ok: false, error: "Asset not found" };
      if (String(existing.revision) !== String(op.expectedRevision)) {
        return { ok: false, error: "Expected revision is stale" };
      }
      set(path, String(op.body ?? ""), String(op.mediaType ?? existing.contentType));
      return { ok: true, file: fileSummary(path) };
    }
    if (op.op === "delete") {
      if (existing && op.expectedRevision !== undefined && String(existing.revision) !== String(op.expectedRevision)) {
        return { ok: false, error: "Expected revision is stale" };
      }
      files.delete(path);
      return { ok: true };
    }
    if (op.op === "rename") {
      const fromPath = String(op.fromPath ?? "");
      const toPath = String(op.toPath ?? "");
      const source = files.get(fromPath);
      if (!source) return { ok: false, error: "Asset not found" };
      if (files.has(toPath)) return { ok: false, error: "File path already exists" };
      if (String(source.revision) !== String(op.expectedRevision)) {
        return { ok: false, error: "Expected revision is stale" };
      }
      files.delete(fromPath);
      files.set(toPath, { ...source, revision: source.revision + 1 });
      return { ok: true, file: fileSummary(toPath) };
    }
    return { ok: false, error: `unsupported op ${String(op.op)}` };
  }

  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (url.endsWith("/sync/apply") && init?.method === "POST") {
      const { operations } = JSON.parse(String(init.body)) as {
        operations: Array<Record<string, unknown>>;
      };
      seen.appliedOps.push(operations);
      const results = operations.map((op) => ({
        path: op.op === "rename" ? String(op.toPath) : String(op.path),
        ...apply(op),
      }));
      return json({
        ok: true,
        applied: results.filter((result) => result.ok).length,
        files: results.filter((result) => result.ok && "file" in result && result.file).map((result) => result.file),
        results,
      });
    }
    if (/\/files$/.test(url)) {
      return json({ ok: true, files: [...files.keys()].map(fileSummary) });
    }
    const fileMatch = /\/files\/(.+)$/.exec(url);
    if (fileMatch) {
      const path = decodeURIComponent(fileMatch[1]!);
      const file = files.get(path);
      if (!file) return json({ ok: false, error: "not found" }, 404);
      return json({ ok: true, file: { revision: String(file.revision), body: file.body } });
    }
    return json({ ok: false, error: `unexpected ${url}` }, 500);
  };

  function visibleFiles(): Record<string, string> {
    return Object.fromEntries(
      [...files.entries()]
        .filter(([path]) => !path.endsWith(".conflict"))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, file]) => [path, file.body]),
    );
  }

  return { fetchImpl, files, seen, visibleFiles };
}

let rootA: string;
let rootB: string;

beforeEach(async () => {
  rootA = await makeRoot("a");
  rootB = await makeRoot("b");
});

afterEach(async () => {
  await Promise.all([
    rm(rootA, { recursive: true, force: true }),
    rm(rootB, { recursive: true, force: true }),
  ]);
});

async function makeRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(nativeTmpdir(), `dohc-sync-stress-${label}-`));
  await mkdir(join(root, ".dohc", "history"), { recursive: true });
  await writeFile(
    join(root, ".dohc", "manifest.json"),
    JSON.stringify({ version: 1, workspaceId: "ws-stress", kind: "shared", mode: "cloud-first-local-copy" }),
  );
  await writeFile(join(root, ".dohc", "history", "index.json"), "[]");
  return root;
}

function engine(rootDir: string, server: ReturnType<typeof fakeServer>): MergeSync {
  return createMergeSync({
    rootDir,
    remoteWorkspaceId: "ws-stress",
    serverUrl: "http://cloud.test",
    token: "tok",
    fetch: server.fetchImpl,
  });
}

async function put(root: string, path: string, body: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), body);
}

async function visibleLocalFiles(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true })) {
    const rel = String(entry).split(sep).join("/");
    if (rel === ".dohc" || rel.startsWith(".dohc/") || rel.endsWith(".conflict")) continue;
    const full = join(root, rel);
    if ((await stat(full)).isFile()) out[rel] = await readFile(full, "utf8");
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

async function dohcSurvived(root: string): Promise<void> {
  expect(existsSync(join(root, ".dohc", "manifest.json"))).toBe(true);
  expect(existsSync(join(root, ".dohc", "history", "index.json"))).toBe(true);
}

async function assertConverged(
  server: ReturnType<typeof fakeServer>,
  trace: string[],
): Promise<void> {
  const remote = server.visibleFiles();
  const localA = await visibleLocalFiles(rootA);
  const localB = await visibleLocalFiles(rootB);
  const failureDetails = () =>
    `${trace.join("\n")}\nA=${JSON.stringify(localA, null, 2)}\nB=${JSON.stringify(localB, null, 2)}\nRemote=${JSON.stringify(remote, null, 2)}`;
  expect(localA, failureDetails()).toEqual(remote);
  expect(localB, failureDetails()).toEqual(remote);
  await dohcSurvived(rootA);
  await dohcSurvived(rootB);
  expect(Object.keys(remote).some((path) => path.endsWith(".conflict"))).toBe(false);
  for (const body of Object.values(remote)) {
    expect(body).not.toMatch(/<<<<<<<|=======|>>>>>>>/);
  }
}

async function syncBoth(a: MergeSync, b: MergeSync): Promise<void> {
  await a.push();
  await b.pull();
  await b.push();
  await a.pull();
}

describe("merge sync deterministic collaboration stress", () => {
  it("converges clean random file operations across two desktop workspaces", async () => {
    const seed = 0x51594e43;
    const rng = seededRandom(seed);
    const trace: string[] = [`seed ${seed}`];
    const paths = [
      "notes/a.md",
      "notes/b.txt",
      "data/table.csv",
      "views/index.html",
      "archive/old.md",
    ];
    const server = fakeServer();
    const syncA = engine(rootA, server);
    const syncB = engine(rootB, server);
    await syncA.initialize();
    await syncB.initialize();

    try {
      for (let step = 0; step < 36; step++) {
        const root = rng() < 0.5 ? rootA : rootB;
        const actor = root === rootA ? "A" : "B";
        const local = await visibleLocalFiles(root);
        const existing = Object.keys(local);
        const missing = paths.filter((path) => !existing.includes(path));
        const opRoll = rng();

        if (existing.length === 0 || (missing.length > 0 && opRoll < 0.3)) {
          const path = pick(rng, missing.length > 0 ? missing : paths);
          const body = `created by ${actor} at ${step}\n`;
          trace.push(`${step}: ${actor} create ${path}`);
          await put(root, path, body);
        } else if (existing.length > 0 && opRoll < 0.58) {
          const path = pick(rng, existing);
          trace.push(`${step}: ${actor} edit ${path}`);
          await put(root, path, `${local[path]}edited by ${actor} at ${step}\n`);
        } else if (existing.length > 0 && missing.length > 0 && opRoll < 0.82) {
          const fromPath = pick(rng, existing);
          const toPath = pick(rng, missing);
          trace.push(`${step}: ${actor} rename ${fromPath} -> ${toPath}`);
          await mkdir(dirname(join(root, toPath)), { recursive: true });
          await rename(join(root, fromPath), join(root, toPath));
        } else if (existing.length > 0) {
          const path = pick(rng, existing);
          trace.push(`${step}: ${actor} delete ${path}`);
          await rm(join(root, path));
        }

        await syncBoth(syncA, syncB);
        await assertConverged(server, trace);
      }

      expect((await syncA.push()).pushed).toBe(0);
      expect((await syncB.push()).pushed).toBe(0);
      expect((await syncA.pull()).pulled).toBe(0);
      expect((await syncB.pull()).pulled).toBe(0);
    } catch (error) {
      throw new Error(`merge sync clean stress failed\n${trace.join("\n")}\n${String(error)}`);
    }
  }, 30_000);

  it("preserves both sides of deterministic same-file offline conflicts without uploading conflict files", async () => {
    const seed = 0xc0ff1c7;
    const trace: string[] = [`seed ${seed}`];
    const server = fakeServer();
    const syncA = engine(rootA, server);
    const syncB = engine(rootB, server);
    await syncA.initialize();
    await syncB.initialize();

    try {
      for (let step = 0; step < 18; step++) {
        const path = `notes/conflict-${step}.md`;
        const base = `# Conflict ${step}\n\nbase\n`;
        const aEdit = `${base}owner offline token ${seed}-${step}\n`;
        const bEdit = `${base}member offline token ${seed}-${step}\n`;
        trace.push(`${step}: conflict ${path}`);
        await put(rootA, path, base);
        await syncA.push();
        await syncB.pull();

        await put(rootA, path, aEdit);
        await put(rootB, path, bEdit);
        await syncA.push();
        const pull = await syncB.pull();
        expect(pull.conflicts, trace.join("\n")).toContain(path);

        expect(await readFile(join(rootB, path), "utf8")).toBe(bEdit);
        expect(await readFile(join(rootB, `${path}.conflict`), "utf8")).toBe(aEdit);
        expect(await readFile(join(rootB, path), "utf8")).not.toMatch(/<<<<<<<|=======|>>>>>>>/);
        expect(await readFile(join(rootB, `${path}.conflict`), "utf8")).not.toMatch(/<<<<<<<|=======|>>>>>>>/);

        const push = await syncB.push();
        expect(push.pushed, trace.join("\n")).toBe(0);
        expect(server.files.has(`${path}.conflict`)).toBe(false);
        expect(server.files.get(path)?.body).toBe(aEdit);
      }
      await dohcSurvived(rootA);
      await dohcSurvived(rootB);
    } catch (error) {
      throw new Error(`merge sync conflict stress failed\n${trace.join("\n")}\n${String(error)}`);
    }
  }, 30_000);
});
