import { DohcSdkError, DohcSdkErrorCodes, } from "./index.js";
export function abortedError(method) {
    return new DohcSdkError(DohcSdkErrorCodes.aborted, `dohc request ${method} was aborted.`);
}
export function assertRequestOptions(options) {
    if (options?.timeoutMs !== undefined &&
        (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
        throw new DohcSdkError(DohcSdkErrorCodes.invalidInput, "Request timeoutMs must be a positive finite number.");
    }
}
