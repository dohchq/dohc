import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrapWorkspaceDataKey } from "@dohc/security-contract/secret-key-envelope";
import type {
  DaemonErrorCode,
  Event,
  JsonValue,
  Request,
  Response,
  Retryability,
} from "@dohc/workspace-engine-client";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineDaemonClient } from "./engineDaemonLifecycle";
import {
  EngineRelayClient,
  RelayConfiguredDaemonClientSource,
  RelayTransportRouteGuard,
  type EngineRelayWorkspaceClient,
} from "./engineRelayClient";
import { EngineWorkspaceSessions } from "./engineWorkspaceSessions";
import { enrollWorkspaceKeyEnvelope } from "./workspaceKeyEnvelopeEnrollment";

const WORKSPACE_ID = "sentinel-key-envelope-workspace";
const PASSPHRASE = "sentinel boundary passphrase";
const SENTINEL = Buffer.from("DOHC_RAW_KEY_SENTINEL_20260728!!", "ascii");
const ETAG = "e".repeat(64);

type Refusal = {
  code: DaemonErrorCode;
  message: string;
  retry: Retryability;
};

type KeyBehavior =
  | { kind: "accept"; envelopeJson?: string }
  | { kind: "refuseUpload"; refusal: Refusal }
  | { kind: "missingDownload"; refusal: Refusal }
  | { kind: "scripted"; steps: KeyStep[] };

type KeyStep =
  | { method: "keys.upload"; result: "accept" | "conflict" }
  | {
      method: "keys.download";
      result: "found" | "missing";
      etag?: string;
    };

function snapshotError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { value: String(error) };
  const record = error as Error & {
    wireCode?: unknown;
    retry?: unknown;
    disposition?: unknown;
    cause?: unknown;
    wireError?: unknown;
  };
  return {
    name: record.name,
    message: record.message,
    wireCode: record.wireCode,
    retry: record.retry,
    disposition: record.disposition,
    wireError: record.wireError,
    cause:
      record.cause instanceof Error
        ? {
            name: record.cause.name,
            message: record.cause.message,
            wireError: (
              record.cause as Error & { wireError?: unknown }
            ).wireError,
          }
        : record.cause,
  };
}

class BoundaryRecordingDaemon implements EngineDaemonClient {
  readonly outboundFrames: Request[] = [];
  readonly inboundFrames: unknown[] = [];
  readonly emittedEvents: Event[] = [];
  readonly observedEvents: Event[] = [];
  readonly stderr: string[] = [];
  readonly rawErrors: Record<string, unknown>[] = [];
  private readonly eventHandlers = new Set<(event: Event) => void>();
  private uploadedEnvelope: string | null = null;

  constructor(private readonly behavior: KeyBehavior) {}

  onEvent(handler: (event: Event) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  private emit(event: Event): void {
    this.emittedEvents.push(structuredClone(event));
    for (const handler of this.eventHandlers) handler(event);
  }

  private response(request: Request, result: JsonValue): Response {
    const response = { id: request.id, result } satisfies Response;
    this.inboundFrames.push(structuredClone(response));
    return response;
  }

  private refuse(request: Request, refusal: Refusal): never {
    const errorFrame = { id: request.id, error: refusal };
    this.inboundFrames.push(structuredClone(errorFrame));
    const error = Object.assign(new Error(refusal.message), {
      name: "EngineClientError",
      wireError: refusal,
    });
    this.rawErrors.push(snapshotError(error));
    throw error;
  }

  private nextStep(method: KeyStep["method"]): KeyStep | null {
    if (this.behavior.kind !== "scripted") return null;
    const step = this.behavior.steps.shift();
    if (!step || step.method !== method) {
      throw new Error(
        `Expected scripted ${step?.method ?? "end of script"}, received ${method}.`,
      );
    }
    return step;
  }

  async sendRequest(request: Request): Promise<Response> {
    this.outboundFrames.push(structuredClone(request));
    switch (request.method) {
      case "workspace.open":
        return this.response(request, { workspace: "sentinel-workspace-handle" });
      case "workspace.close":
        return this.response(request, { closed: true });
      case "keys.upload": {
        const params = request.params as Record<
          string,
          JsonValue | undefined
        >;
        this.emit({
          seq: this.emittedEvents.length + 1,
          sessionGeneration: 1,
          name: "relay.keyEnvelopeTransport",
          payload: {
            method: "keys.upload",
            custody: "opaque",
            workspaceId: params.workspaceId ?? null,
            envelopeJson: params.envelopeJson ?? null,
            ifMatch: params.ifMatch ?? null,
          },
        });
        this.stderr.push(
          `[daemon] keys.upload ${JSON.stringify(request.params)}`,
        );
        if (this.behavior.kind === "refuseUpload") {
          this.refuse(request, this.behavior.refusal);
        }
        const step = this.nextStep("keys.upload");
        if (step?.method === "keys.upload" && step.result === "conflict") {
          this.refuse(request, {
            code: "CONFLICT",
            message: "relay key envelope conflict",
            retry: "no",
          });
        }
        this.uploadedEnvelope = String(params.envelopeJson);
        return this.response(request, { etag: ETAG });
      }
      case "keys.download": {
        if (this.behavior.kind === "missingDownload") {
          this.refuse(request, this.behavior.refusal);
        }
        const step = this.nextStep("keys.download");
        if (step?.method === "keys.download" && step.result === "missing") {
          this.refuse(request, {
            code: "KEY_ENVELOPE_MISSING",
            message: "relay key envelope missing",
            retry: "no",
          });
        }
        const envelopeJson =
          this.behavior.kind === "accept"
            ? (this.behavior.envelopeJson ?? this.uploadedEnvelope)
            : (this.uploadedEnvelope ?? '{"wrapped":"current"}');
        if (envelopeJson === null) {
          throw new Error("Boundary mock has no envelope to download.");
        }
        const result = {
          envelopeJson,
          etag:
            step?.method === "keys.download" && step.result === "found"
              ? (step.etag ?? ETAG)
              : ETAG,
        };
        this.emit({
          seq: this.emittedEvents.length + 1,
          sessionGeneration: 1,
          name: "relay.keyEnvelopeTransport",
          payload: {
            method: "keys.download",
            custody: "opaque",
            workspaceId: (
              request.params as Record<string, JsonValue | undefined>
            ).workspaceId,
            envelopeJson: result.envelopeJson,
            etag: result.etag,
          },
        });
        this.stderr.push(
          `[daemon] keys.download ${JSON.stringify({ request: request.params, result })}`,
        );
        return this.response(request, result);
      }
      default:
        throw new Error(`Unexpected boundary request: ${request.method}`);
    }
  }

  close(): void {}
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function harness(behavior: KeyBehavior): Promise<{
  daemon: BoundaryRecordingDaemon;
  client: EngineRelayWorkspaceClient;
  sessions: EngineWorkspaceSessions;
}> {
  const rootPath = await mkdtemp(join(tmpdir(), "dohc-key-boundary-"));
  roots.push(rootPath);
  const daemon = new BoundaryRecordingDaemon(behavior);
  daemon.onEvent((event) => daemon.observedEvents.push(structuredClone(event)));
  const routes = new RelayTransportRouteGuard();
  const sessions = new EngineWorkspaceSessions(
    new RelayConfiguredDaemonClientSource(
      { currentClient: () => daemon },
      routes,
    ),
    { transportRebindAttempts: 1 },
  );
  const relay = new EngineRelayClient({
    sessions,
    routes,
    requestDeadlineMs: 1_000,
  });
  return {
    daemon,
    client: relay.bind({
      workspaceId: WORKSPACE_ID,
      rootPath,
      relay: { baseUrl: "https://relay.test", token: "boundary-token" },
    }),
    sessions,
  };
}

function recordingErrors(
  transport: EngineRelayWorkspaceClient,
  translatedErrors: Record<string, unknown>[],
): EngineRelayWorkspaceClient {
  return {
    ...transport,
    uploadKeyEnvelope: async (input) => {
      try {
        return await transport.uploadKeyEnvelope(input);
      } catch (error) {
        translatedErrors.push(snapshotError(error));
        throw error;
      }
    },
    downloadKeyEnvelope: async () => {
      try {
        return await transport.downloadKeyEnvelope();
      } catch (error) {
        translatedErrors.push(snapshotError(error));
        throw error;
      }
    },
  };
}

function sentinelEncodings(sentinel: Buffer): string[] {
  const ascii = sentinel.toString("ascii");
  return [
    ascii,
    sentinel.toString("base64"),
    sentinel.toString("hex"),
    JSON.stringify(ascii).slice(1, -1),
    [...sentinel]
      .map((byte) => `\\u${byte.toString(16).padStart(4, "0")}`)
      .join(""),
    JSON.stringify([...sentinel]),
  ];
}

function expectNoSentinel(
  label: string,
  surfaces: unknown,
  sentinel = SENTINEL,
): void {
  const serialized = JSON.stringify(surfaces);
  const bytes = Buffer.from(serialized, "utf8");
  for (const encoding of sentinelEncodings(sentinel)) {
    expect(
      serialized.includes(encoding),
      `MUTATION: raw workspace key sentinel leaked into ${label} as ${encoding}`,
    ).toBe(false);
    expect(
      bytes.includes(Buffer.from(encoding, "utf8")),
      `MUTATION: raw workspace key sentinel bytes leaked into ${label}`,
    ).toBe(false);
  }
}

describe("workspace key-envelope daemon custody boundary", () => {
  it("keeps the raw-key sentinel out of live RPC/error captures and mock diagnostics", async () => {
    expect(SENTINEL).toHaveLength(32);
    const wrapped = await wrapWorkspaceDataKey({
      dataKey: SENTINEL,
      passphrase: PASSPHRASE,
      workspaceId: WORKSPACE_ID,
    });

    const upload = await harness({ kind: "accept" });
    const uploadErrors: Record<string, unknown>[] = [];
    await enrollWorkspaceKeyEnvelope({
      workspaceId: WORKSPACE_ID,
      dataKey: Buffer.from(SENTINEL),
      passphrase: PASSPHRASE,
      transport: recordingErrors(upload.client, uploadErrors),
      installDataKey: async () => {
        throw new Error("Upload enrollment must not install a key.");
      },
    });
    await upload.sessions.closeAll();

    const download = await harness({
      kind: "accept",
      envelopeJson: wrapped.envelopeJson,
    });
    const downloadErrors: Record<string, unknown>[] = [];
    const installed: Buffer[] = [];
    await enrollWorkspaceKeyEnvelope({
      workspaceId: WORKSPACE_ID,
      dataKey: null,
      passphrase: PASSPHRASE,
      transport: recordingErrors(download.client, downloadErrors),
      installDataKey: async (dataKey) => {
        installed.push(Buffer.from(dataKey));
      },
    });
    expect(installed).toEqual([SENTINEL]);
    installed[0]?.fill(0);
    await download.sessions.closeAll();

    const uploadRefusal = await harness({
      kind: "refuseUpload",
      refusal: {
        code: "FORBIDDEN",
        message: "workspace operation failed",
        retry: "no",
      },
    });
    const uploadRefusalErrors: Record<string, unknown>[] = [];
    const uploadRefusalError = await enrollWorkspaceKeyEnvelope({
      workspaceId: WORKSPACE_ID,
      dataKey: Buffer.from(SENTINEL),
      passphrase: PASSPHRASE,
      transport: recordingErrors(
        uploadRefusal.client,
        uploadRefusalErrors,
      ),
      installDataKey: async () => undefined,
    }).catch((error: unknown) => error);
    expect(uploadRefusalError).toMatchObject({
      name: "DaemonRefusalError",
      wireCode: "FORBIDDEN",
      disposition: "terminal",
    });
    const uploadRefusalEnrollmentErrors = [snapshotError(uploadRefusalError)];
    await uploadRefusal.sessions.closeAll();

    const missing = await harness({
      kind: "missingDownload",
      refusal: {
        code: "KEY_ENVELOPE_MISSING",
        message: "workspace operation failed",
        retry: "no",
      },
    });
    const missingErrors: Record<string, unknown>[] = [];
    await expect(
      enrollWorkspaceKeyEnvelope({
        workspaceId: WORKSPACE_ID,
        dataKey: null,
        passphrase: PASSPHRASE,
        transport: recordingErrors(missing.client, missingErrors),
        installDataKey: async () => {
          throw new Error("A missing envelope must not install a key.");
        },
      }),
    ).resolves.toBeUndefined();
    expect(missingErrors).toContainEqual(
      expect.objectContaining({ name: "RelayKeyEnvelopeMissingError" }),
    );
    await missing.sessions.closeAll();

    const boundaries = [
      ["upload boundary", upload.daemon, uploadErrors],
      ["download boundary", download.daemon, downloadErrors],
      [
        "upload refusal boundary",
        uploadRefusal.daemon,
        [...uploadRefusalErrors, ...uploadRefusalEnrollmentErrors],
      ],
      ["missing download boundary", missing.daemon, missingErrors],
    ] as const;
    for (const [label, daemon, translatedErrors] of boundaries) {
      expectNoSentinel(label, {
        outboundFrames: daemon.outboundFrames,
        inboundFrames: daemon.inboundFrames,
        emittedEvents: daemon.emittedEvents,
        observedEvents: daemon.observedEvents,
        stderr: daemon.stderr,
        rawErrors: daemon.rawErrors,
        translatedErrors,
      });
    }

    const keyRequests = boundaries.flatMap(([, daemon]) =>
      daemon.outboundFrames.filter((frame) => frame.method.startsWith("keys.")),
    );
    expect(keyRequests.length).toBeGreaterThanOrEqual(4);
    expect(
      keyRequests
        .filter((frame) => frame.method === "keys.upload")
        .every(
          (frame) =>
            typeof (frame.params as Record<string, unknown>).envelopeJson ===
            "string",
        ),
    ).toBe(true);
  }, 30_000);
});

describe("workspace key-envelope conflict retries", () => {
  it("retries a create conflict with the downloaded etag as ifMatch", async () => {
    const fetchedEtag = "f".repeat(64);
    const context = await harness({
      kind: "scripted",
      steps: [
        { method: "keys.upload", result: "conflict" },
        { method: "keys.download", result: "found", etag: fetchedEtag },
        { method: "keys.upload", result: "accept" },
      ],
    });

    await enrollWorkspaceKeyEnvelope({
      workspaceId: WORKSPACE_ID,
      dataKey: Buffer.from(SENTINEL),
      passphrase: PASSPHRASE,
      transport: context.client,
      installDataKey: async () => undefined,
    });

    const uploads = context.daemon.outboundFrames.filter(
      (frame) => frame.method === "keys.upload",
    );
    expect(uploads).toHaveLength(2);
    expect(uploads[0]?.params).not.toHaveProperty("ifMatch");
    expect(uploads[1]?.params).toMatchObject({ ifMatch: fetchedEtag });
    await context.sessions.closeAll();
  });

  it("retries create-only when the envelope vanishes during CAS", async () => {
    const context = await harness({
      kind: "scripted",
      steps: [
        { method: "keys.upload", result: "conflict" },
        { method: "keys.download", result: "missing" },
        { method: "keys.upload", result: "accept" },
      ],
    });

    await enrollWorkspaceKeyEnvelope({
      workspaceId: WORKSPACE_ID,
      dataKey: Buffer.from(SENTINEL),
      passphrase: PASSPHRASE,
      transport: context.client,
      installDataKey: async () => undefined,
    });

    const uploads = context.daemon.outboundFrames.filter(
      (frame) => frame.method === "keys.upload",
    );
    expect(uploads).toHaveLength(2);
    expect(uploads[0]?.params).not.toHaveProperty("ifMatch");
    expect(uploads[1]?.params).not.toHaveProperty("ifMatch");
    await context.sessions.closeAll();
  });

  it("stops after three conflicts with the kept-changing error", async () => {
    const context = await harness({
      kind: "scripted",
      steps: [
        { method: "keys.upload", result: "conflict" },
        { method: "keys.download", result: "found" },
        { method: "keys.upload", result: "conflict" },
        { method: "keys.download", result: "found" },
        { method: "keys.upload", result: "conflict" },
        { method: "keys.download", result: "found" },
      ],
    });

    await expect(
      enrollWorkspaceKeyEnvelope({
        workspaceId: WORKSPACE_ID,
        dataKey: Buffer.from(SENTINEL),
        passphrase: PASSPHRASE,
        transport: context.client,
        installDataKey: async () => undefined,
      }),
    ).rejects.toMatchObject({
      name: "RelayConflictError",
      message:
        "Relay key envelope kept changing concurrently; upload did not complete.",
    });
    expect(
      context.daemon.outboundFrames.filter(
        (frame) => frame.method === "keys.upload",
      ),
    ).toHaveLength(3);
    await context.sessions.closeAll();
  });
});
