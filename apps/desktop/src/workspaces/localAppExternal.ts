import { AppBackendRuntimeError } from "@dohc/app-backend-runtime";
import {
  APP_EXTERNAL_TIMEOUT_MS,
  AppExternalInputError,
  renderAppExternalRequest,
  type AppExternalOperation,
} from "@dohc/security-contract/app-external";
import {
  DeclaredHttpsError,
  parseSafeOutboundHttpsUrl,
  SafeOutboundError,
  sendDeclaredHttps,
  type DeclaredHttpsTransport,
} from "@dohc/service-http";
import type { LocalWorkspaceSecretStore } from "./localWorkspaceSecretStore";

export const LOCAL_APP_EXTERNAL_IN_FLIGHT = 8;

export interface LocalAppExternal {
  /** Why this workspace can't use secrets kept on this computer now, or null. */
  unavailable(): string | null;
  /** `current` throws once the app's approval is gone. It runs again right before the request is sent. */
  call(
    operation: AppExternalOperation,
    input: unknown,
    signal: AbortSignal,
    current: () => void,
  ): Promise<{ status: number; data: unknown }>;
}

const refuse = (code: string, message: string) => new AppBackendRuntimeError({ code, message });

/** Sends an approved app's declared requests with a secret kept on this computer. */
export function createLocalAppExternal(options: {
  workspaceId: string;
  secrets: LocalWorkspaceSecretStore;
  unavailable(): string | null;
  transport?: DeclaredHttpsTransport;
}): LocalAppExternal {
  let inFlight = 0;
  const call: LocalAppExternal["call"] = async (operation, input, signal, current) => {
    let request;
    try {
      request = renderAppExternalRequest(operation, input);
    } catch (error) {
      if (error instanceof AppExternalInputError) throw refuse("external_input", error.message);
      throw error;
    }
    const unavailable = options.unavailable();
    if (unavailable) throw refuse("external_unavailable", unavailable);
    if (inFlight >= LOCAL_APP_EXTERNAL_IN_FLIGHT)
      throw refuse(
        "external_busy",
        `This workspace already has ${LOCAL_APP_EXTERNAL_IN_FLIGHT} outside calls running. Try again when one finishes.`,
      );
    inFlight++;
    try {
      return await sendDeclaredHttps({
        request,
        host: operation.host,
        maxResponseBytes: operation.response.maxBytes,
        timeoutMs: APP_EXTERNAL_TIMEOUT_MS,
        signal,
        ...(options.transport ? { transport: options.transport } : {}),
        secret: async () => {
          const name = operation.secret.name;
          if (!options.secrets.canKeep())
            throw refuse(
              "external_secret",
              "This computer's system keychain is unavailable, so dohc can't read workspace secrets.",
            );
          const secret = await options.secrets.readSecretForExecution(options.workspaceId, name);
          if (!secret)
            throw refuse("external_secret", `Secret ${name} isn't in Settings > Secrets.`);
          if (secret.summary.usage !== "http-header")
            throw refuse(
              "external_secret",
              `Secret ${name} is a webhook address. Save it as a header value instead.`,
            );
          if (!secret.summary.allowedHosts.includes(operation.host))
            throw refuse(
              "external_secret",
              `Secret ${name} isn't allowed for ${operation.host}. Add that website to it in Settings > Secrets.`,
            );
          const blocked = options.unavailable();
          if (blocked) throw refuse("external_unavailable", blocked);
          current();
          signal.throwIfAborted();
          return {
            header: operation.secret.header,
            prefix: operation.secret.prefix,
            value: secret.value,
          };
        },
      });
    } catch (error) {
      if (error instanceof DeclaredHttpsError) throw refuse(error.code, error.message);
      throw error;
    } finally {
      inFlight--;
    }
  };
  return { unavailable: options.unavailable, call };
}

/** Sends to a loopback fixture in desktop tests, after the same host check. Never used in a packaged app. */
export function loopbackAppExternalTransport(origin: string): DeclaredHttpsTransport {
  return {
    async resolve(url, allowedHosts) {
      const parsed = parseSafeOutboundHttpsUrl(url);
      if (!parsed || !allowedHosts.has(parsed.hostname)) throw new Error("Host not allowed.");
      return {
        href: parsed.href,
        url: parsed,
        canonicalHost: parsed.hostname,
        address: "127.0.0.1",
        family: 4,
      };
    },
    async read(request, signal) {
      const url = request.destination.url;
      const response = await fetch(`${origin}${url.pathname}${url.search}`, {
        method: request.method ?? "POST",
        headers: { ...request.headers, "x-dohc-test-host": url.hostname },
        ...(request.body ? { body: new Uint8Array(request.body) } : {}),
        redirect: "manual",
        ...(signal ? { signal } : {}),
      });
      const body = Buffer.from(await response.arrayBuffer());
      if (body.byteLength > (request.maxResponseBytes ?? 0))
        throw new SafeOutboundError("response_too_large", "too large");
      return {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        body,
      };
    },
  };
}
