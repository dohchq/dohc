import {
  PUSH_DEVICES_PATH,
  type ApnsEnvironment,
  type PushDeviceStatus,
} from "@dohc/workspace-contracts/push-subscriptions";
import { okAnswer } from "./api";
import type { ServerClient } from "./client";

const PATH = `/sync${PUSH_DEVICES_PATH}`;

function readStatus(body: unknown): PushDeviceStatus | null {
  const answer = okAnswer(body);
  if (answer?.available === false) return { ok: true, available: false };
  if (answer?.available !== true) return null;
  const { enabled, generation } = answer;
  if (enabled === false && generation === null)
    return { ok: true, available: true, enabled, generation };
  return enabled === true && typeof generation === "number" && Number.isSafeInteger(generation)
    ? { ok: true, available: true, enabled, generation }
    : null;
}

export const readPushDevice = (client: ServerClient, signal: AbortSignal) =>
  client.send("GET", PATH, readStatus, undefined, { signal });

export const bindPushDevice = (
  client: ServerClient,
  device: { readonly token: string; readonly environment: ApnsEnvironment },
  signal: AbortSignal,
) => client.send("PUT", PATH, readStatus, device, { signal });

export const removePushDevice = (client: ServerClient, generation: number, signal: AbortSignal) =>
  client.send("DELETE", PATH, readStatus, { generation }, { signal });
