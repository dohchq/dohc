// Client for the yrs stdio harness (crates/yrs-spike/src/main.rs).
// One long-lived child process; line-delimited JSON; bytes as base64.

import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline";

const CRATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

export type RootKind = "map" | "text" | "xmlFragment";
export type RootSchema = Record<string, RootKind>;

// The dohc Y.Doc schema (packages/ydoc-projection/src/import-export.ts).
export const DOHC_SCHEMA: RootSchema = {
  frontmatter: "map",
  meta: "map",
  body: "xmlFragment",
  plainText: "text",
};

interface OkResponse {
  ok: true;
  [key: string]: unknown;
}
interface ErrResponse {
  ok: false;
  error: string;
}
type Response = OkResponse | ErrResponse;

function binaryPath(): string {
  const exe = process.platform === "win32" ? "dohc-yrs-spike.exe" : "dohc-yrs-spike";
  const targetDir = process.env.CARGO_TARGET_DIR ?? join(CRATE_DIR, "target");
  return join(targetDir, "debug", exe);
}

export function buildRustHarness(): void {
  const result = spawnSync("cargo", ["build"], { cwd: CRATE_DIR, stdio: "inherit", shell: false });
  if (result.status !== 0) throw new Error("cargo build failed");
}

export class RustPeer {
  private child: ChildProcessByStdio<Writable, Readable, null>;
  private queue: Array<(v: Response) => void> = [];

  constructor() {
    const bin = binaryPath();
    if (!existsSync(bin)) buildRustHarness();
    this.child = spawn(bin, [], { stdio: ["pipe", "pipe", "inherit"] });
    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on("line", (line) => {
      const resolve = this.queue.shift();
      if (resolve) resolve(JSON.parse(line) as Response);
    });
  }

  private request(payload: Record<string, unknown>): Promise<Response> {
    if (process.env.RUST_PEER_TRACE) {
      console.error(`>> ${JSON.stringify(payload).slice(0, 160)}`);
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  /** Send a request that must succeed. */
  private async ok(payload: Record<string, unknown>): Promise<OkResponse> {
    const res = await this.request(payload);
    if (!res.ok) throw new Error(`rust ${String(payload.op)}: ${res.error}`);
    return res;
  }

  async newDoc(id: string, clientId?: number): Promise<void> {
    await this.ok({ op: "new", id, ...(clientId !== undefined ? { clientId } : {}) });
  }

  /** Apply update bytes; returns an error string instead of throwing so fuzz
   * fault-injection can assert on rejection. */
  async apply(id: string, update: Uint8Array): Promise<string | null> {
    const res = await this.request({ op: "apply", id, update: b64(update) });
    return res.ok ? null : res.error;
  }

  async state(id: string): Promise<{ sv: Uint8Array; update: Uint8Array }> {
    const res = await this.ok({ op: "state", id });
    return { sv: fromB64(res.sv as string), update: fromB64(res.update as string) };
  }

  async diff(id: string, sv: Uint8Array): Promise<Uint8Array> {
    const res = await this.ok({ op: "diff", id, sv: b64(sv) });
    return fromB64(res.update as string);
  }

  async content(id: string, schema: RootSchema = DOHC_SCHEMA): Promise<unknown> {
    const res = await this.ok({ op: "content", id, schema });
    return res.content;
  }

  async merge(updates: Uint8Array[]): Promise<Uint8Array> {
    const res = await this.ok({ op: "merge", updates: updates.map(b64) });
    return fromB64(res.update as string);
  }

  async textInsert(id: string, field: string, index: number, text: string): Promise<Uint8Array> {
    const res = await this.ok({ op: "textInsert", id, field, index, text });
    return fromB64(res.update as string);
  }

  async textDelete(id: string, field: string, index: number, len: number): Promise<Uint8Array> {
    const res = await this.ok({ op: "textDelete", id, field, index, len });
    return fromB64(res.update as string);
  }

  async xmlInsertParagraph(
    id: string,
    field: string,
    index: number,
    text: string,
  ): Promise<Uint8Array> {
    const res = await this.ok({ op: "xmlInsertParagraph", id, field, index, text });
    return fromB64(res.update as string);
  }

  async xmlTextInsert(
    id: string,
    field: string,
    para: number,
    offset: number,
    text: string,
    attrs?: Record<string, unknown>,
  ): Promise<Uint8Array> {
    const res = await this.ok({ op: "xmlTextInsert", id, field, para, offset, text, attrs });
    return fromB64(res.update as string);
  }

  async xmlTextDelete(
    id: string,
    field: string,
    para: number,
    offset: number,
    len: number,
  ): Promise<Uint8Array> {
    const res = await this.ok({ op: "xmlTextDelete", id, field, para, offset, len });
    return fromB64(res.update as string);
  }

  async free(id: string): Promise<void> {
    await this.ok({ op: "free", id });
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}
