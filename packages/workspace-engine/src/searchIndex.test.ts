import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENGINE_SEARCH_INDEX_DDL, type EngineSqliteDb } from "./engineDbSchema";
import {
  pathIsSearchIndexed,
  queryChatMessagesGranular,
  readEngineSearchPolicySync,
} from "./searchIndex";

// Lets a test simulate a present-but-unreadable policy file (EACCES/EIO)
// deterministically on every platform; all other node:fs calls pass through.
const fsOverride = vi.hoisted(() => ({ readError: null as NodeJS.ErrnoException | null }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    if (fsOverride.readError) throw fsOverride.readError;
    return actual.readFileSync(...args);
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync };
});

const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (path: string) => EngineSqliteDb;
};

let db: EngineSqliteDb;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(ENGINE_SEARCH_INDEX_DDL);
});

afterEach(() => {
  db.close();
});

function insertChatSearchRow(input: {
  workspaceId: string;
  threadId: string;
  messageId: string;
  text: string;
}): void {
  db.prepare(
    `INSERT INTO engine_search_chat_messages_fts (workspace_id, thread_id, message_id, text)
     VALUES (?, ?, ?, ?)`,
  ).run(input.workspaceId, input.threadId, input.messageId, input.text);
}

describe("search policy fail-closed", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dohc-search-policy-"));
  });

  afterEach(() => {
    fsOverride.readError = null;
    rmSync(root, { recursive: true, force: true });
  });

  function errnoError(code: string): NodeJS.ErrnoException {
    const error: NodeJS.ErrnoException = new Error(`${code}: simulated`);
    error.code = code;
    return error;
  }

  it("treats absent policy files as defaults (ENOENT is a configuration)", () => {
    const policy = readEngineSearchPolicySync(root);
    expect(policy).toEqual({ filesPolicy: null, visibilityPolicy: null, diagnostics: [] });
    expect(pathIsSearchIndexed(root, "notes/a.md", policy)).toBe(true);
  });

  it("applies a valid policy without diagnostics", () => {
    mkdirSync(join(root, ".dohc"), { recursive: true });
    writeFileSync(
      join(root, ".dohc", "visibility.toml"),
      '[[rule]]\npath = "private/**"\nvisibility = "hidden"\n',
    );
    const policy = readEngineSearchPolicySync(root);
    expect(policy.diagnostics).toEqual([]);
    expect(pathIsSearchIndexed(root, "private/x.md", policy)).toBe(false);
    expect(pathIsSearchIndexed(root, "notes/x.md", policy)).toBe(true);
  });

  it("fails closed when a policy file exists but does not parse", () => {
    mkdirSync(join(root, ".dohc"), { recursive: true });
    writeFileSync(join(root, ".dohc", "files.toml"), "not [ valid toml");
    const policy = readEngineSearchPolicySync(root);
    expect(policy.diagnostics).toMatchObject([{ file: "files.toml", reason: "invalid" }]);
    expect(pathIsSearchIndexed(root, "notes/a.md", policy)).toBe(false);
  });

  it("fails closed on valid TOML with an invalid policy shape", () => {
    mkdirSync(join(root, ".dohc"), { recursive: true });
    writeFileSync(join(root, ".dohc", "visibility.toml"), 'title = "not a policy"\n');
    const policy = readEngineSearchPolicySync(root);
    expect(policy.diagnostics).toMatchObject([{ file: "visibility.toml", reason: "invalid" }]);
    expect(pathIsSearchIndexed(root, "notes/a.md", policy)).toBe(false);
  });

  it("fails closed when a policy file exists but cannot be read (EACCES)", () => {
    mkdirSync(join(root, ".dohc"), { recursive: true });
    writeFileSync(join(root, ".dohc", "files.toml"), "");
    fsOverride.readError = errnoError("EACCES");
    const policy = readEngineSearchPolicySync(root);
    expect(policy.diagnostics).toMatchObject([
      { file: "files.toml", reason: "unreadable", detail: "EACCES" },
    ]);
    expect(pathIsSearchIndexed(root, "notes/a.md", policy)).toBe(false);
  });

  it("fails closed when the policy path is not a regular file", () => {
    mkdirSync(join(root, ".dohc", "visibility.toml"), { recursive: true });
    const policy = readEngineSearchPolicySync(root);
    expect(policy.diagnostics).toMatchObject([
      { file: "visibility.toml", reason: "unreadable" },
    ]);
    expect(pathIsSearchIndexed(root, "notes/a.md", policy)).toBe(false);
  });

  it("fails closed when a policy file exceeds the size limit (matches desktop's 256 KiB cap)", () => {
    mkdirSync(join(root, ".dohc"), { recursive: true });
    // Just over the shared 256 KiB cap; a file the desktop reader also rejects.
    writeFileSync(join(root, ".dohc", "files.toml"), "#".repeat(256 * 1024 + 1));
    const policy = readEngineSearchPolicySync(root);
    expect(policy.diagnostics).toMatchObject([{ file: "files.toml", reason: "unreadable" }]);
    expect(pathIsSearchIndexed(root, "notes/a.md", policy)).toBe(false);
  });

  it("accepts a valid policy between the old 64 KiB and the 256 KiB cap", () => {
    mkdirSync(join(root, ".dohc"), { recursive: true });
    // ~100 KiB of valid rules: over the previous 64 KiB engine cap, under the
    // desktop's 256 KiB — must parse and apply, not fail closed.
    const rules = Array.from(
      { length: 1200 },
      (_, index) => `[[rule]]\npath = "private-${index}/**"\nvisibility = "hidden"\n`,
    ).join("");
    expect(rules.length).toBeGreaterThan(64 * 1024);
    expect(rules.length).toBeLessThan(256 * 1024);
    writeFileSync(join(root, ".dohc", "visibility.toml"), rules);
    const policy = readEngineSearchPolicySync(root);
    expect(policy.diagnostics).toEqual([]);
    expect(pathIsSearchIndexed(root, "private-5/x.md", policy)).toBe(false);
    expect(pathIsSearchIndexed(root, "notes/x.md", policy)).toBe(true);
  });

  it("reports only the broken file; the absent one still means defaults", () => {
    mkdirSync(join(root, ".dohc"), { recursive: true });
    writeFileSync(join(root, ".dohc", "visibility.toml"), "not [ valid toml");
    const policy = readEngineSearchPolicySync(root);
    expect(policy.filesPolicy).toBeNull();
    expect(policy.diagnostics).toHaveLength(1);
    expect(policy.diagnostics[0]).toMatchObject({ file: "visibility.toml" });
  });
});

describe("queryChatMessagesGranular", () => {
  it("returns each matching message row with its message id", () => {
    insertChatSearchRow({
      workspaceId: "workspace-a",
      threadId: "thread-1",
      messageId: "message-1",
      text: "The stable needle appears first.",
    });
    insertChatSearchRow({
      workspaceId: "workspace-a",
      threadId: "thread-1",
      messageId: "message-2",
      text: "The stable needle appears again.",
    });
    insertChatSearchRow({
      workspaceId: "workspace-b",
      threadId: "thread-other",
      messageId: "message-other",
      text: "The stable needle belongs elsewhere.",
    });

    expect(
      queryChatMessagesGranular(db, {
        workspaceId: "workspace-a",
        query: "stable needle",
        limit: 10,
      }),
    ).toEqual([
      {
        threadId: "thread-1",
        messageId: "message-1",
        text: "The stable needle appears first.",
      },
      {
        threadId: "thread-1",
        messageId: "message-2",
        text: "The stable needle appears again.",
      },
    ]);
  });

  it("maps a matching thread-title row to a null message id", () => {
    insertChatSearchRow({
      workspaceId: "workspace-a",
      threadId: "thread-1",
      messageId: "__thread__",
      text: "Quarterly planning decisions",
    });

    expect(
      queryChatMessagesGranular(db, {
        workspaceId: "workspace-a",
        query: "planning",
        limit: 10,
      }),
    ).toEqual([
      {
        threadId: "thread-1",
        messageId: null,
        text: "Quarterly planning decisions",
      },
    ]);
    expect(
      queryChatMessagesGranular(db, {
        workspaceId: "workspace-a",
        query: "pl",
        limit: 10,
      }),
    ).toEqual([]);
    expect(
      queryChatMessagesGranular(db, {
        workspaceId: "workspace-a",
        query: "planning",
        limit: -1,
      }),
    ).toEqual([]);
  });
});
