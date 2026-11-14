import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicReplaceFile } from "../atomicReplaceFile";
import type { TokenCipher } from "../workspaces/cloudCredentialStore";
import type { T3CodeSignIn } from "./t3Code";

// dohc's sign-in to T3 Code on this computer. It can drive every thread the
// person has there, so it is kept only encrypted with the system's credential
// encryption, never in plain text, and never synced. When the system cannot
// encrypt, nothing is kept and dohc does not connect T3 Code.
//
// The encryption keeps the sign-in from other people who use this computer
// and from a copy of the file. It does not keep it from another program
// running as the same person, which can ask the system to decrypt it.

const FILE_NAME = "dohc-t3-code.json";

const Kept = z
  .object({
    version: z.literal(1),
    origin: z.string().min(1),
    expiresAtMs: z.number(),
    token: z.string().min(1),
  })
  .strict();
// What a request header can carry. A decryption that went wrong fails this.
const VISIBLE_ASCII = /^[\x21-\x7e]+$/u;

/**
 * Whether Electron's credential storage encrypts with a key the system keeps.
 * On Linux it falls back to a key fixed in its own source (basic_text) when
 * no keyring answers, and reports unknown before it has chosen one. Neither
 * keeps a secret, so neither counts.
 */
export function encryptsWithSystemKey(
  platform: NodeJS.Platform,
  linuxBackend: string | null,
): boolean {
  return platform !== "linux" || (linuxBackend !== "basic_text" && linuxBackend !== "unknown");
}

export class T3CodeSignInNotKept extends Error {
  constructor() {
    super("This computer cannot encrypt dohc's sign-in to T3 Code, so dohc did not connect it.");
    this.name = "T3CodeSignInNotKept";
  }
}

export interface T3CodeSignInStore {
  /** True when this computer can encrypt the sign-in. */
  canKeep(): boolean;
  /** The kept sign-in, or null when there is none, it ran out, or it cannot be read. */
  load(): Promise<T3CodeSignIn | null>;
  /** Keeps the sign-in encrypted. Throws T3CodeSignInNotKept when this computer cannot encrypt. */
  save(signIn: T3CodeSignIn): Promise<void>;
  clear(): Promise<void>;
}

export function createT3CodeSignInStore(options: {
  dir: string;
  cipher?: TokenCipher;
  nowMs?: () => number;
}): T3CodeSignInStore {
  const file = join(options.dir, FILE_NAME);
  const nowMs = options.nowMs ?? Date.now;
  const canKeep = () => options.cipher?.isAvailable() === true;
  // Each save and clear finishes before the next starts, so a save still
  // writing cannot bring back a sign-in a later clear dropped.
  let last: Promise<unknown> = Promise.resolve();
  const inOrder = <T>(change: () => Promise<T>): Promise<T> => {
    const done = last.then(change, change);
    last = done.catch(() => undefined);
    return done;
  };
  return {
    canKeep,
    async load() {
      if (!canKeep()) return null;
      try {
        const kept = Kept.parse(JSON.parse(await readFile(file, "utf8")));
        if (kept.expiresAtMs <= nowMs()) return null;
        const token = options.cipher!.decrypt(kept.token);
        return VISIBLE_ASCII.test(token)
          ? { origin: kept.origin, token, expiresAtMs: kept.expiresAtMs }
          : null;
      } catch {
        return null;
      }
    },
    save: (signIn) =>
      inOrder(async () => {
        if (!canKeep()) throw new T3CodeSignInNotKept();
        const kept: z.infer<typeof Kept> = {
          version: 1,
          origin: signIn.origin,
          expiresAtMs: signIn.expiresAtMs,
          token: options.cipher!.encrypt(signIn.token),
        };
        await mkdir(options.dir, { recursive: true, mode: 0o700 });
        await atomicReplaceFile(file, (tmp) =>
          writeFile(tmp, `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 }),
        );
      }),
    clear: () =>
      inOrder(async () => {
        await unlink(file).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }),
  };
}
