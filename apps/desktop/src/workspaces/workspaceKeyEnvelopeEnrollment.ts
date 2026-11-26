import {
  SecretKeyEnvelopeError,
  envelopeKeyCheck,
  unwrapWorkspaceDataKey,
  workspaceDataKeyCheck,
  wrapWorkspaceDataKey,
} from "@dohc/security-contract/secret-key-envelope";
import {
  NO_PASSPHRASE_YET,
  OTHER_KEY_PROTECTS,
  validateSecretPassphrase,
} from "@dohc/security-contract/secret-passphrase";
import {
  RelayConflictError,
  RelayKeyEnvelopeMissingError,
  RelayWorkspaceUnavailableError,
} from "@dohc/workspace-contracts/relay";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EngineRelayWorkspaceClient } from "./engineRelayClient";
import { SECRET_KEY_RELATIVE_PATH } from "./workspaceDataKey";

const KEY_ENVELOPE_UPLOAD_ATTEMPTS = 3;

async function uploadReplacingCurrentEnvelope(
  transport: EngineRelayWorkspaceClient,
  envelopeJson: string,
  keyCheck: string,
): Promise<void> {
  let ifMatch: string | undefined;
  for (let attempt = 0; attempt < KEY_ENVELOPE_UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      await transport.uploadKeyEnvelope({
        envelopeJson,
        ...(ifMatch === undefined ? {} : { ifMatch }),
      });
      return;
    } catch (error) {
      if (!(error instanceof RelayConflictError)) throw error;
    }

    let current: { envelopeJson: string; etag: string };
    try {
      current = await transport.downloadKeyEnvelope();
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
    const currentKeyCheck = envelopeKeyCheck(current.envelopeJson);
    if (currentKeyCheck !== null && currentKeyCheck !== keyCheck) {
      throw new Error(OTHER_KEY_PROTECTS);
    }
    ifMatch = current.etag;
  }
  throw new RelayConflictError(
    "Relay key envelope kept changing concurrently; upload did not complete.",
  );
}

async function protect(input: {
  workspaceId: string;
  dataKey: Buffer;
  passphrase: string;
  transport: EngineRelayWorkspaceClient;
}): Promise<void> {
  const passphraseError = validateSecretPassphrase(input.passphrase);
  if (passphraseError) throw new Error(passphraseError);
  const keyCheck = workspaceDataKeyCheck(input.dataKey, input.workspaceId);
  const { envelopeJson } = await wrapWorkspaceDataKey({
    dataKey: input.dataKey,
    passphrase: input.passphrase,
    workspaceId: input.workspaceId,
  });
  await uploadReplacingCurrentEnvelope(input.transport, envelopeJson, keyCheck);
}

async function unlock(input: {
  workspaceId: string;
  envelopeJson: string;
  passphrase: string | undefined;
  installDataKey: (dataKey: Buffer) => Promise<void>;
}): Promise<void> {
  if (!input.passphrase) {
    throw new Error("Passphrase required to unlock synced secrets.");
  }
  let unwrapped: Buffer;
  try {
    unwrapped = await unwrapWorkspaceDataKey({
      envelopeJson: input.envelopeJson,
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

async function downloadEnvelope(transport: EngineRelayWorkspaceClient): Promise<string | null> {
  try {
    return (await transport.downloadKeyEnvelope()).envelopeJson;
  } catch (error) {
    if (error instanceof RelayKeyEnvelopeMissingError) return null;
    throw error;
  }
}

/**
 * Whether this computer's workspace secret key still needs a passphrase on the
 * server before other computers can open its protected files. Undefined while
 * this computer has no key.
 */
export async function keyNeedsPassphrase(
  rootPath: string,
  transport: Pick<EngineRelayWorkspaceClient, "downloadKeyEnvelope">,
): Promise<boolean | undefined> {
  if (!existsSync(join(resolve(rootPath), SECRET_KEY_RELATIVE_PATH))) return undefined;
  try {
    await transport.downloadKeyEnvelope();
    return false;
  } catch (error) {
    if (error instanceof RelayKeyEnvelopeMissingError) return true;
    throw error;
  }
}

/**
 * `dataKey` is this computer's key, "missing" when protected files arrived
 * without it, or null when the workspace has no protected files.
 */
export async function enrollWorkspaceKeyEnvelope(input: {
  workspaceId: string;
  dataKey: Buffer | "missing" | null;
  passphrase?: string;
  resume?: boolean;
  transport: EngineRelayWorkspaceClient;
  installDataKey: (dataKey: Buffer) => Promise<void>;
}): Promise<void> {
  const { dataKey } = input;
  if (Buffer.isBuffer(dataKey)) {
    try {
      if (input.resume && (await downloadEnvelope(input.transport)) !== null) return;
      await protect({
        workspaceId: input.workspaceId,
        dataKey,
        passphrase: input.passphrase ?? "",
        transport: input.transport,
      });
    } finally {
      dataKey.fill(0);
    }
    return;
  }

  const envelopeJson = await downloadEnvelope(input.transport);
  if (envelopeJson === null) {
    if (dataKey === "missing") throw new Error(NO_PASSPHRASE_YET);
    return;
  }
  await unlock({
    workspaceId: input.workspaceId,
    envelopeJson,
    passphrase: input.passphrase,
    installDataKey: input.installDataKey,
  });
}
