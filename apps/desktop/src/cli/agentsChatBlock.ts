import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
  type FileHandle,
} from "node:fs/promises";
import { resolve } from "node:path";

export const AGENTS_CHAT_BEGIN_MARKER = "<!-- dohc:chat:begin -->";
export const AGENTS_CHAT_END_MARKER = "<!-- dohc:chat:end -->";

export const AGENTS_CHAT_MANAGED_BLOCK = `${AGENTS_CHAT_BEGIN_MARKER}
## dohc chats

This workspace has chats. Run \`dohc chat inbox\` to see what needs you, \`dohc chat grep <pattern>\` to search, \`dohc chat show <thread|message>\` to read context, and \`dohc chat reply <thread>\` to respond.

Always pass \`--as-agent\` on every chat write. Pass it on each invocation because environment variables do not persist between agent harness tool calls.
${AGENTS_CHAT_END_MARKER}`;

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code;
}

const updateTails = new Map<string, Promise<void>>();

function unsafeAgentsFile(path: string): Error {
  return new Error(`Refusing to update ${path}: AGENTS.md must be a regular file.`);
}

async function checkedHandle(path: string, handle: FileHandle): Promise<FileHandle> {
  try {
    const info = await handle.stat();
    if (info.isFile()) return handle;
    throw unsafeAgentsFile(path);
  } catch (error: unknown) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function openAgentsFile(path: string): Promise<FileHandle> {
  const noFollow = fsConstants.O_NOFOLLOW;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) throw unsafeAgentsFile(path);
      try {
        return await checkedHandle(
          path,
          await open(path, fsConstants.O_RDWR | noFollow),
        );
      } catch (error: unknown) {
        if (hasErrorCode(error, "ENOENT")) continue;
        if (hasErrorCode(error, "ELOOP")) throw unsafeAgentsFile(path);
        throw error;
      }
    } catch (error: unknown) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
      try {
        return await checkedHandle(
          path,
          await open(
            path,
            fsConstants.O_RDWR |
              fsConstants.O_CREAT |
              fsConstants.O_EXCL |
              noFollow,
            0o666,
          ),
        );
      } catch (createError: unknown) {
        if (hasErrorCode(createError, "EEXIST")) continue;
        if (hasErrorCode(createError, "ELOOP")) throw unsafeAgentsFile(path);
        throw createError;
      }
    }
  }
  throw new Error(`Refusing to update ${path}: AGENTS.md changed during validation.`);
}

async function writeHandle(handle: FileHandle, text: string): Promise<void> {
  const bytes = Buffer.from(text, "utf8");
  await handle.truncate(0);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (result.bytesWritten <= 0) throw new Error("Failed to update AGENTS.md.");
    offset += result.bytesWritten;
  }
}

async function serializeUpdate<T>(path: string, task: () => Promise<T>): Promise<T> {
  const predecessor = updateTails.get(path) ?? Promise.resolve();
  let release = (): void => undefined;
  const turn = new Promise<void>((resolveTurn) => {
    release = resolveTurn;
  });
  const tail = predecessor.catch(() => undefined).then(() => turn);
  updateTails.set(path, tail);
  await predecessor.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (updateTails.get(path) === tail) updateTails.delete(path);
  }
}

function appendManagedBlock(source: string): string {
  const separator = source.length === 0
    ? ""
    : source.endsWith("\n\n")
      ? ""
      : source.endsWith("\n")
        ? "\n"
        : "\n\n";
  return `${source}${separator}${AGENTS_CHAT_MANAGED_BLOCK}\n`;
}

export function updateAgentsChatBlock(source: string): string {
  let endIndex = source.indexOf(AGENTS_CHAT_END_MARKER);
  let beginIndex = -1;
  while (endIndex !== -1) {
    beginIndex = source.lastIndexOf(AGENTS_CHAT_BEGIN_MARKER, endIndex);
    if (beginIndex !== -1) break;
    endIndex = source.indexOf(
      AGENTS_CHAT_END_MARKER,
      endIndex + AGENTS_CHAT_END_MARKER.length,
    );
  }
  if (beginIndex === -1 || endIndex === -1) return appendManagedBlock(source);

  const suffixStart = endIndex + AGENTS_CHAT_END_MARKER.length;
  return `${source.slice(0, beginIndex)}${AGENTS_CHAT_MANAGED_BLOCK}${source.slice(suffixStart)}`;
}

export async function ensureAgentsChatBlock(workspaceRoot: string): Promise<boolean> {
  const agentsPath = resolve(workspaceRoot, "AGENTS.md");
  return serializeUpdate(agentsPath, async () => {
    const handle = await openAgentsFile(agentsPath);
    try {
      const current = await handle.readFile("utf8");
      const next = updateAgentsChatBlock(current);
      if (next === current) return false;
      await writeHandle(handle, next);
      return true;
    } finally {
      await handle.close();
    }
  });
}
