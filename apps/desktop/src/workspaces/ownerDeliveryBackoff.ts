import {EngineRequestError} from "@dohc/workspace-engine-client/daemon";

export function isOwnerDeliveryBackoff(error: unknown): boolean {
  return error instanceof EngineRequestError && error.wireError?.code === "OVERLOADED" && error.wireError.retry === "afterBackoff";
}
