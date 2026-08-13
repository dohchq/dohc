import {
  DohcSdkError,
  DohcSdkErrorCodes,
  type DohcRequestOptions,
} from "./index.js";

export function abortedError(method: string): DohcSdkError {
  return new DohcSdkError(
    DohcSdkErrorCodes.aborted,
    `dohc request ${method} was aborted.`,
  );
}

export function assertRequestOptions(
  options: DohcRequestOptions | undefined,
): void {
  if (
    options?.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new DohcSdkError(
      DohcSdkErrorCodes.invalidInput,
      "Request timeoutMs must be a positive finite number.",
    );
  }
}
