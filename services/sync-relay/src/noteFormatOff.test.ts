import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc } from "@dohc/ydoc-projection";
import { admitBodySequenceNotes } from "@dohc/ydoc-projection/live-journal-validation";
import { seededNote } from "../../../packages/ydoc-projection/src/bodySequenceChecksTestSupport.js";
import {
  cleanupLiveDeliveryFixtures,
  registered,
} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport.js";
import { openRelayDeployment } from "./relayDeployment.js";
import {
  browserHeaders,
  browserScope,
  cleanups,
  fixture,
  limits,
  phoneHeaders,
  phoneScope,
  phoneState,
} from "./namedLiveRoutes.test-helper";

afterEach(async () => {
  admitBodySequenceNotes(false);
  const owned = cleanups.splice(0).reverse();
  vi.restoreAllMocks();
  for (const cleanup of owned) await cleanup();
  cleanupLiveDeliveryFixtures();
});

function formatOne(): Uint8Array {
  const doc = markdownToYDoc("Hello\n");
  try {
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

function restarted(baseline: Uint8Array, admittedAtRegistration: boolean) {
  admitBodySequenceNotes(admittedAtRegistration);
  const f = registered({ deployment: true, baselineBytes: baseline });
  const document = f.input.evidence.document;
  f.close();
  admitBodySequenceNotes(false);
  const { storage } = openRelayDeployment(f.configPath);
  return { storage, document };
}

it("refuses a format-2 note registered before a restart while the switch is off, and serves it with the switch on", () => {
  const { storage, document } = restarted(seededNote(), true);
  try {
    expect(storage.liveNoteFormatOff(document)).toBe(true);
    admitBodySequenceNotes(true);
    expect(storage.liveNoteFormatOff(document)).toBe(false);
  } finally {
    storage.close();
  }
});

it.each([true, false])(
  "never refuses a format-1 note registered with the switch %s",
  (admitted) => {
    const { storage, document } = restarted(formatOne(), admitted);
    try {
      expect(storage.liveNoteFormatOff(document)).toBe(false);
      admitBodySequenceNotes(true);
      expect(storage.liveNoteFormatOff(document)).toBe(false);
    } finally {
      storage.close();
    }
  },
);

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Client = [
  string,
  () => Promise<{ f: Fixture; connect: () => ReturnType<Fixture["connect"]> }>,
];

const clients: Client[] = [
  [
    "named share page",
    async () => {
      const f = await fixture(limits);
      const { token } = await f.mint();
      return { f, connect: () => f.connect(token) };
    },
  ],
  [
    "link share page",
    async () => {
      const f = await fixture(limits, true);
      const { token } = await f.mint();
      return { f, connect: () => f.connect(token) };
    },
  ],
  [
    "invited desktop",
    async () => {
      const f = await fixture(limits, false, undefined, false, true);
      const { token } = await f.mint();
      return { f, connect: () => f.connect(token) };
    },
  ],
  [
    "owner's desktop",
    async () => {
      const f = await fixture(limits, false, undefined, true);
      return { f, connect: () => f.connect("") };
    },
  ],
  [
    "owner's phone",
    async () => {
      phoneState.expiresAt = 8e12;
      const f = await fixture(limits, false, undefined, true);
      const ticket = (await f.tickets.mint({ objectId: f.binding.objectId }, phoneScope))!;
      return { f, connect: () => f.connect(ticket.token, "", phoneHeaders) };
    },
  ],
  [
    "owner's browser",
    async () => {
      const f = await fixture(limits, false, undefined, true);
      const ticket = (await f.tickets.mint({ objectId: f.binding.objectId }, browserScope))!;
      return { f, connect: () => f.connect(ticket.token, "", browserHeaders) };
    },
  ],
];

const holdFormatTwo = (f: Fixture) =>
  vi
    .spyOn(f.storage, "liveNoteFormatOff")
    .mockImplementation((document) => document.lineageClaimId === f.binding.lineageClaimId);

it.each(clients)(
  "closes the %s's socket on a format-2 note while the switch is off, before its room's capture",
  async (_client, open) => {
    const { f, connect } = await open();
    const formatOff = holdFormatTwo(f);
    const socket = connect();
    expect(await socket.closed).toEqual([1013, "note_format_off"]);
    expect(Math.max(0, ...f.captureNative.mock.invocationCallOrder)).toBeLessThan(
      formatOff.mock.invocationCallOrder[0]!,
    );
  },
);

it.each(clients)(
  "opens the %s's socket on a format-1 note while the switch is off",
  async (_client, open) => {
    const { f, connect } = await open();
    const captures = f.captureNative.mock.calls.length;
    const socket = connect();
    expect(await socket.status).toBe(101);
    await vi.waitFor(() => expect(f.captureNative.mock.calls.length).toBeGreaterThan(captures));
  },
);
