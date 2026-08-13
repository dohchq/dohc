import { expect, it, vi } from "vitest";
import type { RelayWorkspaceIdentity } from "@dohc/workspace-contracts/relay";
import { RelayKeyEnvelopeMissingError } from "@dohc/workspace-contracts/relay";
import { wrapWorkspaceDataKey } from "@dohc/security-contract/secret-key-envelope";
import { bootstrapJoinedWorkspace } from "./workspaceJoinEnrollment";

const IDENTITY: RelayWorkspaceIdentity = {
  replicationEpoch: "epoch-joined",
  streamIdentity: "stream-joined",
};

it("checks the envelope inside the capture-free identity bootstrap", async () => {
  const order: string[] = [];
  const installed: Buffer[] = [];
  const transport = {
    bootstrapJoinIdentity: vi.fn(
      async (
        identity: RelayWorkspaceIdentity | null,
        initialize: () => Promise<void>,
      ) => {
        expect(identity).toEqual(IDENTITY);
        order.push("identity");
        await initialize();
        order.push("closed");
      },
    ),
    downloadKeyEnvelope: vi.fn(async () => {
      order.push("download");
      throw new RelayKeyEnvelopeMissingError();
    }),
  };

  await bootstrapJoinedWorkspace({
    workspaceId: "workspace-joined",
    identity: IDENTITY,
    transport: transport as never,
    installDataKey: async (key) => {
      installed.push(Buffer.from(key));
    },
  });

  expect(order).toEqual(["identity", "download", "closed"]);
  expect(installed).toEqual([]);
});

it("unwraps and installs the joined workspace key before bootstrap closes", async () => {
  const passphrase = "joined workspace passphrase";
  const expected = Buffer.alloc(32, 0x6a);
  const { envelopeJson } = await wrapWorkspaceDataKey({
    workspaceId: "workspace-joined",
    dataKey: expected,
    passphrase,
  });
  const order: string[] = [];
  const installed: Buffer[] = [];
  const transport = {
    bootstrapJoinIdentity: async (
      _identity: RelayWorkspaceIdentity | null,
      initialize: () => Promise<void>,
    ) => {
      order.push("identity");
      await initialize();
      order.push("closed");
    },
    downloadKeyEnvelope: async () => {
      order.push("download");
      return { envelopeJson, etag: "etag-joined" };
    },
  };

  await bootstrapJoinedWorkspace({
    workspaceId: "workspace-joined",
    identity: IDENTITY,
    passphrase,
    transport: transport as never,
    installDataKey: async (key) => {
      order.push("install");
      installed.push(Buffer.from(key));
    },
  });

  expect(order).toEqual(["identity", "download", "install", "closed"]);
  expect(installed).toEqual([expected]);
});
