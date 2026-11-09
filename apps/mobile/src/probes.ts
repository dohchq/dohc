// Phase 0 checks: do dohc's shared TypeScript packages run under Hermes?
import { decodeLiveFrame, encodeLiveFrame, type LiveFrame } from "@dohc/live-session-contract/live-frame";
import { isPortableNamePath, nameByteLength } from "@dohc/workspace-contracts/names";
import * as Y from "yjs";

export interface ProbeResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly ms: number;
}

type Probe = { readonly name: string; run(): Promise<string> | string };

const probes: readonly Probe[] = [
  {
    name: "Hermes engine",
    run: () => {
      const hermes = (globalThis as { HermesInternal?: unknown }).HermesInternal;
      if (!hermes) throw new Error("Not running on Hermes");
      return "HermesInternal present";
    },
  },
  {
    name: "workspace-contracts names",
    run: () => {
      if (nameByteLength("é") !== 2) throw new Error("UTF-8 byte length is wrong");
      if (!isPortableNamePath("notes/today.md")) throw new Error("Portable path refused");
      return "byte length and portable path agree";
    },
  },
  {
    name: "live frame round trip",
    run: () => {
      const frame: LiveFrame = {
        kind: "hello",
        receivePolicy: { maxFrameBytes: 65_536, maxStateVectorBytes: 4_096, maxUpdateBytes: 32_768, maxSyncBytes: 65_536 },
      };
      const bytes = encodeLiveFrame(frame, 65_536);
      const back = decodeLiveFrame(bytes, 65_536);
      if (JSON.stringify(back) !== JSON.stringify(frame)) throw new Error("Decoded frame differs");
      return `${bytes.byteLength} bytes`;
    },
  },
  {
    name: "Yjs merge",
    run: () => {
      const left = new Y.Doc();
      const right = new Y.Doc();
      left.getText("body").insert(0, "hello ");
      right.getText("body").insert(0, "world");
      Y.applyUpdate(right, Y.encodeStateAsUpdate(left, Y.encodeStateVector(right)));
      Y.applyUpdate(left, Y.encodeStateAsUpdate(right, Y.encodeStateVector(left)));
      const a = left.getText("body").toString();
      if (a !== right.getText("body").toString()) throw new Error("Documents did not converge");
      return JSON.stringify(a);
    },
  },
  {
    name: "Web Crypto SHA-256",
    run: async () => {
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("abc"));
      const hex = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
      if (hex !== "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") throw new Error(`Wrong digest ${hex}`);
      return "matches the known digest";
    },
  },
  {
    name: "crypto.randomUUID",
    run: () => {
      const id = crypto.randomUUID();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)) throw new Error(`Bad UUID ${id}`);
      return id;
    },
  },
];

export async function runProbes(): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const probe of probes) {
    const started = performance.now();
    try {
      const detail = await probe.run();
      results.push({ name: probe.name, ok: true, detail, ms: performance.now() - started });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({ name: probe.name, ok: false, detail, ms: performance.now() - started });
    }
  }
  return results;
}
