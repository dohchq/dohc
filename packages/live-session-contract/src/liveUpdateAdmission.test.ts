import { describe, expect, it } from "vitest";
import vectors from "../vectors/live-update-admission-vectors.json";
import {
  LIVE_UPDATE_IDENTIFIER_MAX_BYTES,
  LIVE_UPDATE_REFUSAL_VALUES,
  LIVE_UPDATE_RETRY_VALUES,
  LIVE_UPDATE_SHA256_HEX_LENGTH,
  LIVE_UPDATE_YJS_CLIENT_ID_MAX,
  LIVE_UPDATE_YJS_END_CLOCK_MAX,
  LIVE_UPDATE_YJS_START_CLOCK_MAX,
  parseAdmittedLiveUpdate,
  parseAdmittedLiveUpdateMetadata,
  parseLiveDocumentKey,
  parseLiveUpdateAcceptResult,
  parseLiveUpdateDigest,
  parseLiveUpdateHostApplicationAck,
  parseLiveUpdateIdentifier,
  parseLiveUpdateReceipt,
  parseLiveUpdateRefusal,
  parseLiveUpdateRetry,
  parseLiveUpdateStructRange,
  parseLiveUpdateStructRanges,
  parseLiveUpdateSubmission,
  parseLiveUpdateSubmissionMetadata,
  parseRelayAcceptedLiveUpdate,
  parseServerDerivedLiveUpdateAuthority,
} from "./liveUpdateAdmission.js";

const digestA = "a".repeat(64);

const binding = {
  workspaceId: "workspace-1",
  mainVersionId: "main-1",
  objectId: "object-1",
  lineageClaimId: "lineage-1",
  currentPath: "notes/a.md",
  selectorPaths: ["notes/a.md"],
  restoreFenceGeneration: 0,
};

const authority = {
  principalKind: "named",
  principalId: "person-1",
  grantId: "grant-1",
  grantGeneration: 1,
};

const receipt = {
  deliveryId: "delivery-1",
  updateDigest: digestA,
  journalCursor: 1,
  acceptingHostEpoch: 2,
};

const accepted = {
  receipt,
  binding,
  authority,
  receivedAtMs: 0,
};

const admittedMetadata = {
  accepted,
  firstSeen: [{ clientId: 1, startClock: 0, endClock: 1 }],
};

const vectorParsers = {
  parseAdmittedLiveUpdateMetadata,
  parseLiveDocumentKey,
  parseLiveUpdateAcceptResult,
  parseLiveUpdateHostApplicationAck,
  parseLiveUpdateReceipt,
  parseLiveUpdateStructRange,
  parseLiveUpdateSubmissionMetadata,
  parseRelayAcceptedLiveUpdate,
  parseServerDerivedLiveUpdateAuthority,
} as const;

function vectorParser(name: string): (value: unknown) => unknown {
  const parser = vectorParsers[name as keyof typeof vectorParsers];
  if (parser === undefined) throw new Error(`Unknown vector parser: ${name}`);
  return parser as (value: unknown) => unknown;
}

function withoutField(value: object, field: string): Record<string, unknown> {
  const copy = structuredClone(value) as Record<string, unknown>;
  delete copy[field];
  return copy;
}

function withUnknown(value: object): Record<string, unknown> {
  return { ...structuredClone(value), unexpected: true };
}

describe("live-update shared vectors", () => {
  it("pins every portable literal", () => {
    expect({
      identifierMaxBytes: LIVE_UPDATE_IDENTIFIER_MAX_BYTES,
      sha256HexLength: LIVE_UPDATE_SHA256_HEX_LENGTH,
      yjsClientIdMax: LIVE_UPDATE_YJS_CLIENT_ID_MAX,
      yjsStartClockMax: LIVE_UPDATE_YJS_START_CLOCK_MAX,
      yjsEndClockMax: LIVE_UPDATE_YJS_END_CLOCK_MAX,
      refusals: LIVE_UPDATE_REFUSAL_VALUES,
      retries: LIVE_UPDATE_RETRY_VALUES,
    }).toEqual(vectors.literals);
  });

  for (const row of vectors.accepted) {
    it(`accepts and normalizes ${row.parser}: ${row.case}`, () => {
      const parsed = vectorParser(row.parser)(row.input);
      expect(parsed).toEqual(row.expected);
      expect(parsed).not.toBe(row.input);
    });
  }

  for (const row of vectors.refused) {
    it(`refuses ${row.parser}: ${row.case}`, () => {
      expect(() => vectorParser(row.parser)(row.input)).toThrow();
    });
  }
});

describe("strict JSON objects", () => {
  const cases: readonly {
    name: string;
    parser: (value: unknown) => unknown;
    canonical: Record<string, unknown>;
    requiredField: string;
    addNestedUnknown?: (value: Record<string, unknown>) => void;
  }[] = [
    {
      name: "document key",
      parser: parseLiveDocumentKey,
      canonical: {
        workspaceId: "workspace-1",
        mainVersionId: "main-1",
        objectId: "object-1",
        lineageClaimId: "lineage-1",
      },
      requiredField: "workspaceId",
    },
    {
      name: "server-derived authority",
      parser: parseServerDerivedLiveUpdateAuthority,
      canonical: authority,
      requiredField: "principalId",
    },
    {
      name: "submission metadata",
      parser: parseLiveUpdateSubmissionMetadata,
      canonical: { deliveryId: "delivery-1", updateDigest: digestA, binding },
      requiredField: "deliveryId",
      addNestedUnknown: (value) => {
        (value.binding as Record<string, unknown>).unexpected = true;
      },
    },
    {
      name: "receipt",
      parser: parseLiveUpdateReceipt,
      canonical: receipt,
      requiredField: "journalCursor",
    },
    {
      name: "accepted record",
      parser: parseRelayAcceptedLiveUpdate,
      canonical: accepted,
      requiredField: "receivedAtMs",
      addNestedUnknown: (value) => {
        (value.receipt as Record<string, unknown>).unexpected = true;
      },
    },
    {
      name: "struct range",
      parser: parseLiveUpdateStructRange,
      canonical: { clientId: 1, startClock: 0, endClock: 1 },
      requiredField: "endClock",
    },
    {
      name: "admitted metadata",
      parser: parseAdmittedLiveUpdateMetadata,
      canonical: admittedMetadata,
      requiredField: "firstSeen",
      addNestedUnknown: (value) => {
        ((value.accepted as Record<string, unknown>).authority as Record<
          string,
          unknown
        >).unexpected = true;
      },
    },
    {
      name: "application acknowledgement",
      parser: parseLiveUpdateHostApplicationAck,
      canonical: {
        ...receipt,
        localYDocSequence: 1,
        applicationReplayed: false,
      },
      requiredField: "applicationReplayed",
    },
    {
      name: "accept result",
      parser: parseLiveUpdateAcceptResult,
      canonical: { kind: "accepted", receipt, replayed: false },
      requiredField: "replayed",
      addNestedUnknown: (value) => {
        (value.receipt as Record<string, unknown>).unexpected = true;
      },
    },
  ];

  for (const row of cases) {
    it(`${row.name} accepts only an exact object and returns fresh values`, () => {
      const parsed = row.parser(row.canonical);
      expect(parsed).toEqual(row.canonical);
      expect(parsed).not.toBe(row.canonical);
      expect(() => row.parser(withoutField(row.canonical, row.requiredField))).toThrow();
      expect(() => row.parser(withUnknown(row.canonical))).toThrow();
      expect(() => row.parser(null)).toThrow();
      expect(() => row.parser([])).toThrow();

      if (row.addNestedUnknown !== undefined) {
        const nested = structuredClone(row.canonical);
        row.addNestedUnknown(nested);
        expect(() => row.parser(nested)).toThrow();
      }
    });
  }
});

describe("live-update text and digest fields", () => {
  it("accepts paired supplementary text and rejects malformed or controlled text", () => {
    expect(parseLiveUpdateIdentifier("person-😀")).toBe("person-😀");
    for (const value of ["before\ud800after", "before\udc00after"]) {
      expect(() => parseLiveUpdateIdentifier(value)).toThrow(/UTF-16/);
    }
    for (const value of ["a\u0000b", "a\u001fb", "a\u007fb"]) {
      expect(() => parseLiveUpdateIdentifier(value)).toThrow(/control/);
    }
  });

  it("measures live identifiers in UTF-8 bytes", () => {
    expect(LIVE_UPDATE_IDENTIFIER_MAX_BYTES).toBe(512);
    expect(parseLiveUpdateIdentifier("a".repeat(512))).toHaveLength(512);
    expect(() => parseLiveUpdateIdentifier("a".repeat(513))).toThrow();
    expect(parseLiveUpdateIdentifier("é".repeat(256))).toHaveLength(256);
    expect(() => parseLiveUpdateIdentifier("é".repeat(257))).toThrow();
  });

  it("accepts only lowercase 64-character SHA-256 digests", () => {
    expect(parseLiveUpdateDigest(digestA)).toBe(digestA);
    for (const value of [
      "A".repeat(64),
      "a".repeat(63),
      "a".repeat(65),
      `${"a".repeat(63)}g`,
    ]) {
      expect(() => parseLiveUpdateDigest(value)).toThrow();
    }
  });

  it("preserves existing binding identifier and path bounds", () => {
    const parsed = parseLiveUpdateSubmissionMetadata({
      deliveryId: "delivery-1",
      updateDigest: digestA,
      binding: {
        ...binding,
        workspaceId: "a".repeat(512),
        currentPath: `${"a".repeat(1_021)}.md`,
        selectorPaths: [`${"a".repeat(1_021)}.md`],
      },
    });
    expect(parsed.binding.workspaceId).toHaveLength(512);
    expect(new TextEncoder().encode(parsed.binding.currentPath)).toHaveLength(1_024);

    expect(() =>
      parseLiveUpdateSubmissionMetadata({
        deliveryId: "delivery-1",
        updateDigest: digestA,
        binding: { ...binding, workspaceId: "a".repeat(513) },
      }),
    ).toThrow();
    expect(() =>
      parseLiveUpdateSubmissionMetadata({
        deliveryId: "delivery-1",
        updateDigest: digestA,
        binding: {
          ...binding,
          currentPath: `${"a".repeat(1_022)}.md`,
        },
      }),
    ).toThrow();
  });
});

describe("server-derived authority", () => {
  it("accepts owner, named, and link shapes", () => {
    expect(
      parseServerDerivedLiveUpdateAuthority({
        principalKind: "owner",
        principalId: "owner-1",
        grantId: null,
        grantGeneration: null,
      }),
    ).toEqual({
      principalKind: "owner",
      principalId: "owner-1",
      grantId: null,
      grantGeneration: null,
    });
    for (const principalKind of ["named", "link"] as const) {
      expect(
        parseServerDerivedLiveUpdateAuthority({
          principalKind,
          principalId: "principal-1",
          grantId: "grant-1",
          grantGeneration: 1,
        }),
      ).toMatchObject({ principalKind, grantGeneration: 1 });
    }
  });

  it("rejects every mixed grant nullability and invalid generation", () => {
    const invalid = [
      { principalKind: "owner", principalId: "owner-1", grantId: "grant-1", grantGeneration: 1 },
      { principalKind: "owner", principalId: "owner-1", grantId: null, grantGeneration: 1 },
      { principalKind: "owner", principalId: "owner-1", grantId: "grant-1", grantGeneration: null },
      { principalKind: "named", principalId: "person-1", grantId: null, grantGeneration: null },
      { principalKind: "named", principalId: "person-1", grantId: "grant-1", grantGeneration: null },
      { principalKind: "named", principalId: "person-1", grantId: null, grantGeneration: 1 },
      { principalKind: "link", principalId: "link-1", grantId: "grant-1", grantGeneration: 0 },
    ];
    for (const value of invalid) {
      expect(() => parseServerDerivedLiveUpdateAuthority(value)).toThrow();
    }
  });

  it("reads the authority discriminant once before returning it", () => {
    let reads = 0;
    const input = {
      principalId: "person-1",
      grantId: "grant-1",
      grantGeneration: 1,
    } as Record<string, unknown>;
    Object.defineProperty(input, "principalKind", {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads < 3 ? "named" : "owner";
      },
    });

    expect(parseServerDerivedLiveUpdateAuthority(input)).toEqual({
      principalKind: "named",
      principalId: "person-1",
      grantId: "grant-1",
      grantGeneration: 1,
    });
    expect(reads).toBe(1);
  });
});

describe("binary composition boundaries", () => {
  it("keeps submission bytes outside strict JSON metadata", () => {
    const metadata = { deliveryId: "delivery-1", updateDigest: digestA, binding };
    const bytes = new Uint8Array([1, 2, 3]);
    const parsed = parseLiveUpdateSubmission(metadata, bytes);
    expect(parsed.metadata).toEqual(metadata);
    expect(parsed.metadata).not.toBe(metadata);
    expect(parsed.updateBytes).toBe(bytes);
    expect(Object.keys(parsed.metadata)).toEqual([
      "deliveryId",
      "updateDigest",
      "binding",
    ]);

    for (const field of ["update", "updateBase64"] as const) {
      expect(() =>
        parseLiveUpdateSubmission({ ...metadata, [field]: "AQ==" }, bytes),
      ).toThrow();
    }
    expect(() => parseLiveUpdateSubmission(metadata, new Uint8Array())).toThrow();
    expect(() => parseLiveUpdateSubmission(metadata, [1] as never)).toThrow();
  });

  it("keeps admitted bytes outside strict host-delivery metadata", () => {
    const bytes = new Uint8Array([4]);
    const parsed = parseAdmittedLiveUpdate(admittedMetadata, bytes);
    expect(parsed.metadata).toEqual(admittedMetadata);
    expect(parsed.metadata).not.toBe(admittedMetadata);
    expect(parsed.updateBytes).toBe(bytes);
    expect(Object.keys(parsed.metadata)).toEqual(["accepted", "firstSeen"]);
    expect(() =>
      parseAdmittedLiveUpdate({ ...admittedMetadata, update: [4] }, bytes),
    ).toThrow();
    expect(() => parseAdmittedLiveUpdate(admittedMetadata, new Uint8Array())).toThrow();
    expect(() => parseAdmittedLiveUpdate(admittedMetadata, "AQ==" as never)).toThrow();
  });
});

describe("portable integer boundaries", () => {
  const invalidIntegers = [
    "1",
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    Infinity,
    NaN,
  ];

  it("pins receipt, authority, time, and local-sequence safe integers", () => {
    expect(
      parseLiveUpdateReceipt({
        ...receipt,
        journalCursor: Number.MAX_SAFE_INTEGER,
        acceptingHostEpoch: Number.MAX_SAFE_INTEGER,
      }),
    ).toMatchObject({
      journalCursor: Number.MAX_SAFE_INTEGER,
      acceptingHostEpoch: Number.MAX_SAFE_INTEGER,
    });
    expect(
      parseServerDerivedLiveUpdateAuthority({
        ...authority,
        grantGeneration: Number.MAX_SAFE_INTEGER,
      }),
    ).toMatchObject({ grantGeneration: Number.MAX_SAFE_INTEGER });
    expect(parseRelayAcceptedLiveUpdate({ ...accepted, receivedAtMs: 0 })).toMatchObject({
      receivedAtMs: 0,
    });
    expect(
      parseRelayAcceptedLiveUpdate({
        ...accepted,
        receivedAtMs: Number.MAX_SAFE_INTEGER,
      }),
    ).toMatchObject({ receivedAtMs: Number.MAX_SAFE_INTEGER });
    expect(
      parseLiveUpdateHostApplicationAck({
        ...receipt,
        localYDocSequence: Number.MAX_SAFE_INTEGER,
        applicationReplayed: false,
      }),
    ).toMatchObject({ localYDocSequence: Number.MAX_SAFE_INTEGER });

    for (const value of [0, ...invalidIntegers]) {
      expect(() => parseLiveUpdateReceipt({ ...receipt, journalCursor: value })).toThrow();
      expect(() =>
        parseLiveUpdateReceipt({ ...receipt, acceptingHostEpoch: value }),
      ).toThrow();
      expect(() =>
        parseServerDerivedLiveUpdateAuthority({ ...authority, grantGeneration: value }),
      ).toThrow();
      expect(() =>
        parseLiveUpdateHostApplicationAck({
          ...receipt,
          localYDocSequence: value,
          applicationReplayed: false,
        }),
      ).toThrow();
    }
    for (const value of invalidIntegers) {
      expect(() => parseRelayAcceptedLiveUpdate({ ...accepted, receivedAtMs: value })).toThrow();
    }
  });
});

describe("Yjs struct ranges", () => {
  it("normalizes order and merges overlap and adjacency per client", () => {
    const input = [
      { clientId: 2, startClock: 4, endClock: 5 },
      { clientId: 1, startClock: 2, endClock: 4 },
      { clientId: 1, startClock: 0, endClock: 2 },
      { clientId: 1, startClock: 3, endClock: 6 },
      { clientId: 2, startClock: 0, endClock: 1 },
    ];
    const parsed = parseLiveUpdateStructRanges(input);
    expect(parsed).toEqual([
      { clientId: 1, startClock: 0, endClock: 6 },
      { clientId: 2, startClock: 0, endClock: 1 },
      { clientId: 2, startClock: 4, endClock: 5 },
    ]);
    expect(parsed).not.toBe(input);
    expect(parsed[0]).not.toBe(input[0]);
  });

  it("accepts empty, minimum, and maximum one-element ranges", () => {
    expect(parseLiveUpdateStructRanges([])).toEqual([]);
    expect(parseLiveUpdateStructRange({ clientId: 0, startClock: 0, endClock: 1 })).toEqual({
      clientId: 0,
      startClock: 0,
      endClock: 1,
    });
    expect(
      parseLiveUpdateStructRange({
        clientId: LIVE_UPDATE_YJS_CLIENT_ID_MAX,
        startClock: LIVE_UPDATE_YJS_START_CLOCK_MAX,
        endClock: LIVE_UPDATE_YJS_END_CLOCK_MAX,
      }),
    ).toEqual({
      clientId: LIVE_UPDATE_YJS_CLIENT_ID_MAX,
      startClock: LIVE_UPDATE_YJS_START_CLOCK_MAX,
      endClock: LIVE_UPDATE_YJS_END_CLOCK_MAX,
    });
  });

  it("rejects zero length, reversed, non-integer, and every one-over bound", () => {
    const invalid = [
      { clientId: 1, startClock: 1, endClock: 1 },
      { clientId: 1, startClock: 2, endClock: 1 },
      { clientId: LIVE_UPDATE_YJS_CLIENT_ID_MAX + 1, startClock: 0, endClock: 1 },
      { clientId: 1, startClock: LIVE_UPDATE_YJS_START_CLOCK_MAX + 1, endClock: LIVE_UPDATE_YJS_END_CLOCK_MAX },
      { clientId: 1, startClock: 0, endClock: LIVE_UPDATE_YJS_END_CLOCK_MAX + 1 },
      { clientId: "1", startClock: 0, endClock: 1 },
      { clientId: 1, startClock: -1, endClock: 1 },
      { clientId: 1, startClock: 0.5, endClock: 1 },
      { clientId: 1, startClock: 0, endClock: Infinity },
      { clientId: 1, startClock: 0, endClock: NaN },
    ];
    for (const value of invalid) {
      expect(() => parseLiveUpdateStructRange(value)).toThrow();
    }
  });

  it("rejects sparse range arrays before normalization", () => {
    const sparse = new Array(1);
    expect(() => parseLiveUpdateStructRanges(sparse)).toThrow();
  });

  it("rejects a range array whose index exists only on its prototype", () => {
    const inherited = new Array(1);
    const prototype = Object.create(Array.prototype) as Record<string, unknown>;
    prototype[0] = { clientId: 1, startClock: 0, endClock: 1 };
    Object.setPrototypeOf(inherited, prototype);

    expect(() => parseLiveUpdateStructRanges(inherited)).toThrow();
  });
});

describe("receipt and relay admission records", () => {
  it("keeps the receipt at exactly four wire-identical fields", () => {
    const parsed = parseLiveUpdateReceipt(receipt);
    expect(parsed).toEqual(receipt);
    expect(Object.keys(parsed)).toEqual([
      "deliveryId",
      "updateDigest",
      "journalCursor",
      "acceptingHostEpoch",
    ]);
    expect(() => parseLiveUpdateReceipt({ ...receipt, receivedAtMs: 0 })).toThrow();
    expect(() => parseLiveUpdateReceipt({ ...receipt, deliveryId: "" })).toThrow();
    expect(() => parseLiveUpdateReceipt({ ...receipt, updateDigest: "A".repeat(64) })).toThrow();
  });

  it("preserves receipt, binding, authority, and receipt time without route or bytes", () => {
    const parsed = parseRelayAcceptedLiveUpdate(accepted);
    expect(parsed).toEqual(accepted);
    expect(parsed.receipt).not.toBe(receipt);
    expect(parsed.binding).not.toBe(binding);
    expect(parsed.authority).not.toBe(authority);
    expect(Object.keys(parsed)).toEqual([
      "receipt",
      "binding",
      "authority",
      "receivedAtMs",
    ]);
    expect(() => parseRelayAcceptedLiveUpdate({ ...accepted, route: "device" })).toThrow();
    expect(() => parseRelayAcceptedLiveUpdate({ ...accepted, updateBytes: [1] })).toThrow();
  });
});

describe("host delivery and application acknowledgement", () => {
  it("accepts empty first-seen ranges and preserves normalized ranges", () => {
    expect(parseAdmittedLiveUpdateMetadata({ accepted, firstSeen: [] })).toEqual({
      accepted,
      firstSeen: [],
    });
    expect(
      parseAdmittedLiveUpdateMetadata({
        accepted,
        firstSeen: [
          { clientId: 1, startClock: 1, endClock: 2 },
          { clientId: 1, startClock: 0, endClock: 1 },
        ],
      }).firstSeen,
    ).toEqual([{ clientId: 1, startClock: 0, endClock: 2 }]);
  });

  it("requires and preserves receipt fields, local sequence, and application replay", () => {
    const parsed = parseLiveUpdateHostApplicationAck({
      ...receipt,
      localYDocSequence: 3,
      applicationReplayed: false,
    });
    expect(parsed).toEqual({
      ...receipt,
      localYDocSequence: 3,
      applicationReplayed: false,
    });
    expect(Object.keys(parsed)).toEqual([
      "deliveryId",
      "updateDigest",
      "journalCursor",
      "acceptingHostEpoch",
      "localYDocSequence",
      "applicationReplayed",
    ]);
    for (const value of [undefined, null, 0, "false"]) {
      expect(() =>
        parseLiveUpdateHostApplicationAck({
          ...receipt,
          localYDocSequence: 3,
          applicationReplayed: value,
        }),
      ).toThrow();
    }
  });

  it("keeps relay replay and host-application replay independent", () => {
    for (const admissionReplayed of [false, true]) {
      for (const applicationReplayed of [false, true]) {
        expect(
          parseLiveUpdateAcceptResult({
            kind: "accepted",
            receipt,
            replayed: admissionReplayed,
          }),
        ).toMatchObject({ replayed: admissionReplayed });
        expect(
          parseLiveUpdateHostApplicationAck({
            ...receipt,
            localYDocSequence: 1,
            applicationReplayed,
          }),
        ).toMatchObject({ applicationReplayed });
      }
    }
  });

  it("reads applicationReplayed once before returning it", () => {
    let reads = 0;
    const input = {
      ...receipt,
      localYDocSequence: 1,
    } as Record<string, unknown>;
    Object.defineProperty(input, "applicationReplayed", {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? false : "not-a-boolean";
      },
    });

    expect(parseLiveUpdateHostApplicationAck(input)).toEqual({
      ...receipt,
      localYDocSequence: 1,
      applicationReplayed: false,
    });
    expect(reads).toBe(1);
  });
});

describe("result literals", () => {
  it("accepts one result for every refusal and retry value", () => {
    expect(parseLiveUpdateAcceptResult({ kind: "accepted", receipt, replayed: false })).toEqual({
      kind: "accepted",
      receipt,
      replayed: false,
    });
    for (const reason of LIVE_UPDATE_REFUSAL_VALUES) {
      expect(parseLiveUpdateRefusal(reason)).toBe(reason);
      expect(parseLiveUpdateAcceptResult({ kind: "refused", reason })).toEqual({
        kind: "refused",
        reason,
      });
    }
    for (const reason of LIVE_UPDATE_RETRY_VALUES) {
      expect(parseLiveUpdateRetry(reason)).toBe(reason);
      expect(parseLiveUpdateAcceptResult({ kind: "retry", reason })).toEqual({
        kind: "retry",
        reason,
      });
    }
  });

  it("rejects unknown result kinds, refusal values, and retry values", () => {
    expect(() => parseLiveUpdateRefusal("unknown")).toThrow();
    expect(() => parseLiveUpdateRetry("unknown")).toThrow();
    expect(() => parseLiveUpdateAcceptResult({ kind: "accepted", receipt, replayed: 1 })).toThrow();
    expect(() => parseLiveUpdateAcceptResult({ kind: "refused", reason: "unknown" })).toThrow();
    expect(() => parseLiveUpdateAcceptResult({ kind: "retry", reason: "unknown" })).toThrow();
    expect(() => parseLiveUpdateAcceptResult({ kind: "fatal", reason: "schema" })).toThrow();
  });

  it("reads an accepted result replay flag once before returning it", () => {
    let reads = 0;
    const input = { kind: "accepted", receipt } as Record<string, unknown>;
    Object.defineProperty(input, "replayed", {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? false : "not-a-boolean";
      },
    });

    expect(parseLiveUpdateAcceptResult(input)).toEqual({
      kind: "accepted",
      receipt,
      replayed: false,
    });
    expect(reads).toBe(1);
  });
});

describe("replay identity fixture integrity", () => {
  function normalizedIdentity(value: {
    deliveryId: unknown;
    updateDigest: unknown;
    binding: unknown;
    authority: unknown;
  }): Record<string, unknown> {
    const parsedBinding = parseLiveUpdateSubmissionMetadata({
      deliveryId: value.deliveryId,
      updateDigest: value.updateDigest,
      binding: value.binding,
    });
    return {
      deliveryId: parsedBinding.deliveryId,
      updateDigest: parsedBinding.updateDigest,
      "binding.workspaceId": parsedBinding.binding.workspaceId,
      "binding.mainVersionId": parsedBinding.binding.mainVersionId,
      "binding.objectId": parsedBinding.binding.objectId,
      "binding.lineageClaimId": parsedBinding.binding.lineageClaimId,
      "binding.currentPath": parsedBinding.binding.currentPath,
      "binding.selectorPaths": parsedBinding.binding.selectorPaths,
      "binding.restoreFenceGeneration": parsedBinding.binding.restoreFenceGeneration,
      ...Object.fromEntries(
        Object.entries(parseServerDerivedLiveUpdateAuthority(value.authority)).map(
          ([key, field]) => [`authority.${key}`, field],
        ),
      ),
    };
  }

  it("keeps delivery fixed and changes exactly the named normalized field", () => {
    const expectedFields = [
      "updateDigest",
      "binding.workspaceId",
      "binding.mainVersionId",
      "binding.objectId",
      "binding.lineageClaimId",
      "binding.currentPath",
      "binding.selectorPaths",
      "binding.restoreFenceGeneration",
      "authority.principalKind",
      "authority.principalId",
      "authority.grantId",
      "authority.grantGeneration",
    ];
    expect(vectors.replayIdentityConflicts.map((row) => row.changedField)).toEqual(
      expectedFields,
    );

    for (const row of vectors.replayIdentityConflicts) {
      const original = normalizedIdentity(row.original);
      const conflicting = normalizedIdentity(row.conflicting);
      expect(conflicting.deliveryId, row.case).toBe(original.deliveryId);
      const changed = Object.keys(original).filter(
        (field) => !Object.is(original[field], conflicting[field]) &&
          JSON.stringify(original[field]) !== JSON.stringify(conflicting[field]),
      );
      expect(changed, row.case).toEqual([row.changedField]);
    }
  });
});
