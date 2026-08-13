import { DohcSdkError, type DohcRequestOptions } from "./index.js";
export declare function abortedError(method: string): DohcSdkError;
export declare function assertRequestOptions(options: DohcRequestOptions | undefined): void;
