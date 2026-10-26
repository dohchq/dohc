import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, readdir, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import { z } from "zod";
import { atomicWriteFile } from "../atomicReplaceFile";
import { localStateFolder, type LocalStateWorkspace } from "./workspaceLocalState";
import { assertResolvedWorkspacePath } from "./workspaceRealPath";

const CopyRecord = z.object({ path: z.string(), copy: z.string(), sha256: z.string(), createdAtMs: z.number(), id: z.string() }).strict();
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const guard = { path: ".dohc/local/outside-write-copies", lead: "dohc could not keep a copy of a changed file, so it left the file as it was." };

class CopyRecordError extends Error {
  constructor(readonly path: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

async function readRecord(path: string) {
  const text = await readFile(path, "utf8");
  try { return CopyRecord.parse(JSON.parse(text)); }
  catch (cause) { throw new CopyRecordError(path, cause); }
}

export class OutsideWriteCopyError extends Error {
  override name = "OutsideWriteCopyError";
  constructor(path: string, cause: unknown, rootPath: string, blockingPath?: string) {
    const lead = blockingPath
      ? `dohc could not keep a copy of ${path}, because ${blockingPath} is in the way, so it left ${path} as it was.`
      : `dohc could not keep a copy of ${path}, so it left ${path} as it was.`;
    const next = blockingPath ? `Move ${blockingPath} somewhere else, then choose Try again.`
      : "Check that dohc can write to the workspace folder, then choose Try again.";
    const location = blockingPath ? `Blocking file: ${join(rootPath, blockingPath)}` : `Workspace folder: ${rootPath}`;
    super(`${lead} ${next}\n${location}\nCause: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }

  static async from(path: string, cause: unknown, rootPath: string): Promise<OutsideWriteCopyError> {
    for (const candidate of [".dohc", ".dohc/local", guard.path]) {
      if ((await lstat(join(rootPath, candidate)).catch(() => null))?.isFile()) {
        return new OutsideWriteCopyError(path, cause, rootPath, candidate);
      }
    }
    return new OutsideWriteCopyError(path, cause, rootPath,
      cause instanceof CopyRecordError ? relative(rootPath, cause.path).split(sep).join("/") : undefined);
  }
}

// These copies are ordinary files. The native keptCopies API can list and
// move native displacements, but cannot register a desktop preimage.
async function digest(path: string): Promise<string> {
  const sha = createHash("sha256");
  for await (const chunk of createReadStream(path)) sha.update(chunk);
  return sha.digest("hex");
}

export function outsideWriteCopies(workspace: LocalStateWorkspace) {
  const directory = () => localStateFolder(workspace, "outside-write-copies", guard);
  async function checked(path: string) {
    return (await assertResolvedWorkspacePath({ rootPath: workspace.rootPath,
      absolutePath: join(workspace.rootPath, path), spelled: path,
      label: "Kept copy path", access: "entry" })).resolvedAbsolute;
  }
  let loaded: Promise<z.infer<typeof CopyRecord>[]> | null = null;
  function records() {
    if (loaded === null) loaded = directory().then(async dir =>
      await Promise.all((await readdir(dir)).filter(name => name.endsWith(".json")).map(async name =>
        readRecord(join(dir, name))))).catch(error => {
          loaded = null;
          throw error;
        });
    return loaded;
  }
  return {
    async list(): Promise<[string, string, string][]> {
      const rows: [string, string, string][] = [];
      const savedRecords = await records();
      for (const record of [...savedRecords].sort((a, b) => a.createdAtMs - b.createdAtMs)) {
        const exists = await lstat(await checked(record.copy)).then(entry => entry.isFile(), (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        });
        if (exists) rows.push([record.path, record.copy, record.id]);
        else {
          await unlink(join(await directory(), createHash("sha256").update(record.path).update(record.sha256).digest("hex") + ".json"));
          savedRecords.splice(savedRecords.indexOf(record), 1);
        }
      }
      return rows;
    },
    async beforeWrite(path: string, incoming: Uint8Array | null, admitCopy: (path: string) => void,
      isRecorded: (path: string, sha256: string) => Promise<boolean>): Promise<boolean> {
      const absolute = await checked(path);
      const entry = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (entry === null) return false;
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`dohc could not keep a copy of ${path}, so it left ${path} as it was.`);
      const sha256 = await digest(absolute);
      if ((incoming !== null && hash(incoming) === sha256) || await isRecorded(path, sha256)) return false;
      const savedRecords = await records();
      const dir = await directory();
      const receipt = join(dir, createHash("sha256").update(path).update(sha256).digest("hex") + ".json");
      const previous = await readRecord(receipt).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (previous !== null) {
        const record = previous;
        const savedPath = await checked(record.copy);
        const savedEntry = await lstat(savedPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (record.path === path && record.sha256 === sha256 && savedEntry?.isFile() &&
            !(savedEntry.dev === entry.dev && savedEntry.ino === entry.ino) &&
            await digest(savedPath).then(saved => saved === sha256, () => false)) return false;
      }
      const extension = posix.extname(path);
      const stem = posix.basename(path, extension);
      let copy: string;
      let destination: string;
      let file: FileHandle;
      for (let n = 1; ; n++) {
        copy = posix.join(posix.dirname(path), `${stem} (kept copy${n === 1 ? "" : ` ${n}`})${extension}`);
        admitCopy(copy);
        destination = await checked(copy);
        try { file = await open(destination, "wx", 0o600); break; } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      try {
        const copied = createHash("sha256");
        for await (const chunk of createReadStream(absolute)) {
          copied.update(chunk);
          await file.writeFile(chunk);
        }
        await file.sync();
        if (copied.digest("hex") !== sha256) throw new Error(`${path} changed while dohc kept its copy.`);
      } finally { await file.close(); }
      if (process.platform !== "win32") {
        const parent = await open(dirname(destination), "r");
        try { await parent.sync(); } finally { await parent.close(); }
      }
      // The receipt is durable before the original may be replaced. A failed
      // receipt leaves the original and the copy for the person to recover.
      const record = { path, copy, sha256, createdAtMs: Date.now(), id: randomUUID() };
      await atomicWriteFile(receipt, JSON.stringify(record));
      const previousIndex = savedRecords.findIndex(row => row.path === path && row.sha256 === sha256);
      if (previousIndex === -1) savedRecords.push(record);
      else savedRecords[previousIndex] = record;
      return true;
    },
  };
}
