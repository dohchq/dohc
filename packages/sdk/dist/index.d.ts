export declare const DOHC_SDK_PROTOCOL = "dohc:sdk:v1";
export declare const DohcSdkErrorCodes: {
    readonly hostUnavailable: "DOHC_HOST_UNAVAILABLE";
    readonly hostMissingOrigin: "DOHC_HOST_MISSING_ORIGIN";
    readonly hostTimeout: "DOHC_HOST_TIMEOUT";
    readonly badResponse: "DOHC_BAD_RESPONSE";
};
export type DohcSdkErrorCode = (typeof DohcSdkErrorCodes)[keyof typeof DohcSdkErrorCodes] | (string & {});
export type DohcCapabilityMap = {
    files: {
        read: boolean;
        write: boolean;
    };
    collections: {
        read: boolean;
    };
    provenance: {
        record: boolean;
    };
};
export type DohcSdkRequestMessage = {
    protocol: typeof DOHC_SDK_PROTOCOL;
    id: string;
    method: string;
    params?: unknown;
};
export type DohcSdkResponseMessage = {
    protocol: typeof DOHC_SDK_PROTOCOL;
    id: string;
    ok: true;
    result: unknown;
} | {
    protocol: typeof DOHC_SDK_PROTOCOL;
    id: string;
    ok: false;
    error: {
        code: string;
        message: string;
    };
};
export interface DohcTransport {
    request(method: string, params?: unknown): Promise<unknown>;
}
export type CreateDohcClientOptions = {
    transport?: DohcTransport;
    timeoutMs?: number;
    targetOrigin?: string;
    currentWindow?: Window;
    targetWindow?: Window;
};
export declare class DohcSdkError extends Error {
    readonly code: DohcSdkErrorCode;
    constructor(code: DohcSdkErrorCode, message: string);
}
export declare function createPostMessageTransport(options?: Omit<CreateDohcClientOptions, "transport">): DohcTransport;
export declare function createDohcClient(options?: CreateDohcClientOptions): {
    capabilities: () => Promise<DohcCapabilityMap>;
    files: {
        read: (path: string) => Promise<string>;
    };
    collections: {
        get: (name: string) => {
            list: () => Promise<Record<string, unknown>[]>;
        };
    };
    provenance: {
        record: (summary: string) => Promise<void>;
    };
};
export type DohcClient = ReturnType<typeof createDohcClient>;
export declare const dohc: {
    capabilities: () => Promise<DohcCapabilityMap>;
    files: {
        read: (path: string) => Promise<string>;
    };
    collections: {
        get: (name: string) => {
            list: () => Promise<Record<string, unknown>[]>;
        };
    };
    provenance: {
        record: (summary: string) => Promise<void>;
    };
};
