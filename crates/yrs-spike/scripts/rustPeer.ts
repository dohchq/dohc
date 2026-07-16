// Client for the yrs stdio harness (crates/yrs-spike/src/main.rs).
// One long-lived child process; line-delimited JSON; bytes as base64.

import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline";

const CRATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

// A request that takes longer than this has hit a harness bug (a lost
// response desyncing the queue, a deadlocked child) — fail loudly, never hang.
const REQUEST_TIMEOUT_MS = 30_000;

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
  // A relative CARGO_TARGET_DIR is interpreted by cargo relative to the
  // build cwd (the crate dir) — resolve the spawn path the same way, never
  // against the Node process cwd.
  const env = process.env.CARGO_TARGET_DIR;
  const targetDir =
    env === undefined ? join(CRATE_DIR, "target") : isAbsolute(env) ? env : resolve(CRATE_DIR, env);
  return join(targetDir, "debug", exe);
}

let builtThisProcess = false;

export function buildRustHarness(): void {
  const result = spawnSync("cargo", ["build"], { cwd: CRATE_DIR, stdio: "inherit", shell: false });
  if (result.status !== 0) throw new Error("cargo build failed");
  builtThisProcess = true;
}

export class RustPeer {
  private child: ChildProcessByStdio<Writable, Readable, null>;
  private queue: Array<{ op: string; resolve: (v: Response) => void; reject: (e: Error) => void }> = [];
  private dead: Error | null = null;

  constructor() {
    // Always build (a fresh cargo no-op is sub-second): a stale binary must
    // never certify changed harness sources. Once per driver process is
    // enough — every RustPeer in one run uses the same sources.
    if (!builtThisProcess) buildRustHarness();
    const bin = binaryPath();
    if (!existsSync(bin)) throw new Error(`rust harness binary missing after build: ${bin}`);
    this.child = spawn(bin, [], { stdio: ["pipe", "pipe", "inherit"] });
    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on("line", (line) => {
      const pending = this.queue.shift();
      if (!pending) return;
      let parsed: Response;
      try {
        parsed = JSON.parse(line) as Response;
      } catch {
        // A malformed stdout line means the protocol is desynced — every
        // subsequent response would answer the wrong request. Reject the
        // request that RECEIVED the bad line first (it is already off the
        // queue, and diagnostics must name its op), then kill the rest.
        const error = new Error(
          `rust harness emitted a non-JSON line answering op "${pending.op}": ${line.slice(0, 200)}`,
        );
        pending.reject(error);
        this.fail(error);
        return;
      }
      pending.resolve(parsed);
    });
    this.child.on("error", (err) => this.fail(new Error(`rust harness spawn error: ${err.message}`)));
    this.child.on("exit", (code, signal) => {
      // An exit while requests are pending (or before close()) is a harness
      // failure, never a hang: reject everything in flight.
      if (this.dead === null && (this.queue.length > 0 || !this.closing)) {
        this.fail(new Error(`rust harness exited (code=${code}, signal=${signal}) with ${this.queue.length} request(s) pending`));
      }
    });
  }

  private closing = false;

  // Rejects every in-flight request; callers turn the rejection into a run
  // failure (or, for the pinned Bytes crash probe, an expected outcome).
  private fail(error: Error): void {
    this.dead = error;
    for (const pending of this.queue.splice(0)) pending.reject(error);
    try {
      this.child.kill();
    } catch {
      // already gone
    }
  }

  private request(payload: Record<string, unknown>): Promise<Response> {
    if (process.env.RUST_PEER_TRACE) {
      console.error(`>> ${JSON.stringify(payload).slice(0, 160)}`);
    }
    if (this.dead) return Promise.reject(this.dead);
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`rust harness request timed out after ${REQUEST_TIMEOUT_MS}ms: ${JSON.stringify(payload).slice(0, 160)}`));
      }, REQUEST_TIMEOUT_MS);
      this.queue.push({
        op: String(payload.op),
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  /** Send a request that must succeed. */
  private async ok(payload: Record<string, unknown>): Promise<OkResponse> {
    const res = await this.request(payload);
    if (!res.ok) throw new Error(`rust ${String(payload.op)}: ${res.error}`);
    return res;
  }

  /** offsetKind "bytes" exists solely for the pinned Bytes-divergence probe;
   * every wire-facing doc must use the default utf16. */
  async newDoc(id: string, clientId?: number, offsetKind?: "utf16" | "bytes"): Promise<void> {
    await this.ok({
      op: "new",
      id,
      ...(clientId !== undefined ? { clientId } : {}),
      ...(offsetKind !== undefined ? { offsetKind } : {}),
    });
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

  async textInsert(id: string, field: string, index: number, text: string): Promise<EditResult> {
    const res = await this.ok({ op: "textInsert", id, field, index, text });
    return editResult(res);
  }

  async textDelete(id: string, field: string, index: number, len: number): Promise<EditResult> {
    const res = await this.ok({ op: "textDelete", id, field, index, len });
    return editResult(res);
  }

  async xmlInsertParagraph(
    id: string,
    field: string,
    index: number,
    text: string,
  ): Promise<EditResult> {
    const res = await this.ok({ op: "xmlInsertParagraph", id, field, index, text });
    return editResult(res);
  }

  async xmlTextInsert(
    id: string,
    field: string,
    para: number,
    offset: number,
    text: string,
    attrs?: Record<string, unknown>,
  ): Promise<EditResult> {
    const res = await this.ok({ op: "xmlTextInsert", id, field, para, offset, text, attrs });
    return editResult(res);
  }

  async xmlTextDelete(
    id: string,
    field: string,
    para: number,
    offset: number,
    len: number,
  ): Promise<EditResult> {
    const res = await this.ok({ op: "xmlTextDelete", id, field, para, offset, len });
    return editResult(res);
  }

  async free(id: string): Promise<void> {
    await this.ok({ op: "free", id });
  }

  close(): void {
    this.closing = true;
    this.child.stdin.end();
    this.child.kill();
  }
}

/** A yrs-driven edit: the encoded delta plus whether the edit actually
 * CHANGED the doc (a clamped out-of-range delete is a legal no-op; its
 * "delta" still carries the full delete set, so bytes can't tell). */
export interface EditResult {
  update: Uint8Array;
  changed: boolean;
}

function editResult(res: Record<string, unknown>): EditResult {
  return { update: fromB64(res.update as string), changed: res.changed === true };
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}
