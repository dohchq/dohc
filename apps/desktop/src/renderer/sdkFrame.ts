import {
  DOHC_SDK_PROTOCOL,
  type DohcSdkRequestMessage,
  type DohcSdkResponseMessage,
} from "@dohc/sdk";
import { isLoopbackHostname } from "../security/loopback";

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.username || url.password) return false;
    return url.protocol === "http:" && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

export function isActiveFrameOrigin(origin: string, frameUrl: string): boolean {
  if (!isLoopbackOrigin(origin)) return false;
  try {
    return new URL(origin).origin === new URL(frameUrl).origin;
  } catch {
    return false;
  }
}

export function isDohcSdkRequest(
  value: unknown,
): value is DohcSdkRequestMessage {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<DohcSdkRequestMessage>;
  return (
    request.protocol === DOHC_SDK_PROTOCOL &&
    typeof request.id === "string" &&
    request.id.length > 0 &&
    typeof request.method === "string" &&
    request.method.length > 0
  );
}

export function sdkErrorResponse(
  id: string,
  code: string,
  message: string,
): DohcSdkResponseMessage {
  return {
    protocol: DOHC_SDK_PROTOCOL,
    id,
    ok: false,
    error: { code, message },
  };
}

export function frameUrlWithHostOrigin(url: string): string {
  // Called during render: a malformed preview URL must degrade to a frame
  // that fails to load, never a `new URL` throw that takes the render down.
  try {
    const framed = new URL(url);
    framed.searchParams.set("dohcHostOrigin", window.location.origin);
    return framed.href;
  } catch {
    return url;
  }
}
