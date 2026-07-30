import {
  SecretKeyEnvelopeError,
  unwrapWorkspaceDataKey,
  wrapWorkspaceDataKey,
} from "@dohc/security-contract/secret-key-envelope";
import {
  RelayConflictError,
  RelayKeyEnvelopeMissingError,
  RelayWorkspaceUnavailableError,
} from "@dohc/workspace-contracts/relay";
import { validateSecretPassphrase } from "./secretPassphrase";
import type { EngineRelayWorkspaceClient } from "./engineRelayClient";

const KEY_ENVELOPE_UPLOAD_ATTEMPTS = 3;

async function uploadReplacingCurrentEnvelope(
  transport: EngineRelayWorkspaceClient,
  envelopeJson: string,
): Promise<void> {
  let ifMatch: string | undefined;
  for (
    let attempt = 0;
    attempt < KEY_ENVELOPE_UPLOAD_ATTEMPTS;
    attempt += 1
  ) {
    try {
      await transport.uploadKeyEnvelope({
        envelopeJson,
        ...(ifMatch === undefined ? {} : { ifMatch }),
      });
      return;
    } catch (error) {
      if (!(error instanceof RelayConflictError)) throw error;
    }

    try {
      ifMatch = (await transport.downloadKeyEnvelope()).etag;
    } catch (error) {
      if (
        error instanceof RelayKeyEnvelopeMissingError ||
        error instanceof RelayWorkspaceUnavailableError
      ) {
        ifMatch = undefined;
        continue;
      }
      throw error;
    }
  }
  throw new RelayConflictError(
    "Relay key envelope kept changing concurrently; upload did not complete.",
  );
}

export async function enrollWorkspaceKeyEnvelope(input: {
  workspaceId: string;
  dataKey: Buffer | null;
  passphrase?: string;
  transport: EngineRelayWorkspaceClient;
  installDataKey: (dataKey: Buffer) => Promise<void>;
}): Promise<void> {
  if (input.dataKey) {
    const passphrase = input.passphrase ?? "";
    const passphraseError = validateSecretPassphrase(passphrase);
    if (passphraseError) throw new Error(passphraseError);
    try {
      const { envelopeJson } = await wrapWorkspaceDataKey({
        dataKey: input.dataKey,
        passphrase,
        workspaceId: input.workspaceId,
      });
      await uploadReplacingCurrentEnvelope(input.transport, envelopeJson);
    } finally {
      input.dataKey.fill(0);
    }
    return;
  }

  let envelopeJson: string | null = null;
  try {
    envelopeJson = (await input.transport.downloadKeyEnvelope()).envelopeJson;
  } catch (error) {
    if (!(error instanceof RelayKeyEnvelopeMissingError)) throw error;
  }
  if (!envelopeJson) return;
  if (!input.passphrase) {
    throw new Error("Passphrase required to unlock synced secrets.");
  }

  let unwrapped: Buffer;
  try {
    unwrapped = await unwrapWorkspaceDataKey({
      envelopeJson,
      passphrase: input.passphrase,
      workspaceId: input.workspaceId,
    });
  } catch (error) {
    if (error instanceof SecretKeyEnvelopeError) {
      throw new Error("Passphrase could not unlock synced secrets.");
    }
    throw error;
  }
  try {
    await input.installDataKey(unwrapped);
  } finally {
    unwrapped.fill(0);
  }
}
