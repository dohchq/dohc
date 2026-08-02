import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";
import { z } from "zod";
import { DohcCliError } from "./errors";
import {
  CLI_PROTOCOL_VERSION,
  cliRequestSchema,
  cliTransportResponseSchema,
  parseCliResult,
  type CliRequest,
  type CliRequestWithoutToken,
  type CliResultByVerb,
  type CliVerb,
} from "./protocol";

const TOKEN_FILE = "dohc-cli-token";
const SOCKET_FILE = "dohc-cli.sock";
const ENDPOINT_FILE = "dohc-cli-endpoint";
// The Windows pipe name is a per-boot capability, so it cannot be derived from
// the state dir. The app writes it to the endpoint descriptor and the client
// reads it back. Only a name the app could have produced is dialled: the
// descriptor is a file, and a rewritten one must not redirect the boot token to
// an endpoint of the writer's choosing.
const PIPE_NAME_RE = /^\\\\\.\\pipe\\dohc-cli-[a-f0-9]{32,}$/u;
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
const responseVersionEnvelopeSchema = z
  .object({ protocolVersion: z.number().int().nonnegative() })
  .passthrough();

export interface CliEndpoint {
  stateDir: string;
  socketPath: string;
  tokenPath: string;
}

export interface CliClientOptions {
  stateDir?: string;
  timeoutMs?: number;
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  homeDir?: string;
  transport?: (
    socketPath: string,
    requestLine: string,
    timeoutMs: number | undefined,
  ) => Promise<unknown>;
}

function stateDirCandidates(input: {
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  homeDir: string;
}): string[] {
  const explicit = input.env.DOHC_STATE_DIR ?? input.env.DOHC_TEST_HOME;
  if (explicit) return [resolve(explicit)];
  if (input.platform === "darwin") {
    const applicationSupport = join(input.homeDir, "Library", "Application Support");
    return [
      join(applicationSupport, "dohc"),
      join(applicationSupport, "@dohc", "desktop"),
      join(applicationSupport, "Electron"),
    ];
  }
  if (input.platform === "win32") {
    const appData = input.env.APPDATA;
    // Packaged: userData is %APPDATA%\<productName>. Unpackaged: Electron uses
    // the package name, which is where a developer's app writes its endpoint.
    return appData
      ? [
          join(appData, "dohc"),
          join(appData, "@dohc", "desktop"),
          join(appData, "Electron"),
        ]
      : [];
  }
  const configHome = input.env.XDG_CONFIG_HOME ?? join(input.homeDir, ".config");
  return [
    join(configHome, "dohc"),
    join(configHome, "@dohc", "desktop"),
    join(configHome, "Electron"),
  ];
}

// What discovery waits for in a state dir: the unix socket itself, or the
// descriptor naming the Windows pipe.
interface EndpointCandidate {
  stateDir: string;
  descriptorPath: string;
  tokenPath: string;
}

function candidateForStateDir(
  stateDir: string,
  platform: NodeJS.Platform,
): EndpointCandidate {
  return {
    stateDir,
    descriptorPath: join(
      stateDir,
      platform === "win32" ? ENDPOINT_FILE : SOCKET_FILE,
    ),
    tokenPath: join(stateDir, TOKEN_FILE),
  };
}

function endpointCandidates(
  options: CliClientOptions,
  platform: NodeJS.Platform,
): EndpointCandidate[] {
  if (options.stateDir) {
    return [candidateForStateDir(resolve(options.stateDir), platform)];
  }
  const env = options.env ?? process.env;
  return stateDirCandidates({
    env,
    platform,
    homeDir: options.homeDir ?? homedir(),
  }).map((stateDir) => candidateForStateDir(stateDir, platform));
}

async function canRead(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveEndpoint(
  candidate: EndpointCandidate,
  platform: NodeJS.Platform,
): Promise<CliEndpoint | null> {
  if (!(await canRead(candidate.tokenPath))) return null;
  const { stateDir, tokenPath } = candidate;
  if (platform !== "win32") {
    if (!(await canRead(candidate.descriptorPath))) return null;
    return { stateDir, socketPath: candidate.descriptorPath, tokenPath };
  }
  let described: string;
  try {
    described = (await readFile(candidate.descriptorPath, "utf8")).trim();
  } catch {
    return null;
  }
  if (!PIPE_NAME_RE.test(described)) return null;
  return { stateDir, socketPath: described, tokenPath };
}

export async function locateCliEndpoint(options: CliClientOptions = {}): Promise<CliEndpoint> {
  const platform = options.platform ?? process.platform;
  const candidates = endpointCandidates(options, platform);
  for (const candidate of candidates) {
    const endpoint = await resolveEndpoint(candidate, platform);
    if (endpoint) return endpoint;
  }
  // No live endpoint. A unix path is still nameable, so hand back the preferred
  // one and let the connection report the failure. A pipe name is not.
  if (platform === "win32") throw new DohcCliError("desktop app not running");
  const fallback = candidates[0] ??
    candidateForStateDir(
      join(options.homeDir ?? homedir(), ".config", "dohc"),
      platform,
    );
  return {
    stateDir: fallback.stateDir,
    socketPath: fallback.descriptorPath,
    tokenPath: fallback.tokenPath,
  };
}

async function readToken(path: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new DohcCliError("desktop app not running");
  }
  const parsed = tokenSchema.safeParse(text.trim());
  if (!parsed.success) throw new DohcCliError("desktop app not running");
  return parsed.data;
}

function readResponseLine(
  socketPath: string,
  requestLine: string,
  timeoutMs: number | undefined,
): Promise<unknown> {
  return new Promise((resolveResponse, rejectResponse) => {
    const socket = createConnection(socketPath);
    let settled = false;
    let buffer = "";
    const rejectOnce = (error: DohcCliError): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      rejectResponse(error);
    };
    socket.setEncoding("utf8");
    if (timeoutMs !== undefined) socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.write(`${requestLine}\n`);
    });
    socket.on("data", (chunk: string) => {
      if (settled) return;
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      try {
        const parsed: unknown = JSON.parse(line);
        settled = true;
        socket.end();
        resolveResponse(parsed);
      } catch {
        rejectOnce(new DohcCliError("desktop app returned an invalid response"));
      }
    });
    socket.once("timeout", () => {
      rejectOnce(new DohcCliError("desktop app did not respond"));
    });
    socket.once("error", () => {
      rejectOnce(new DohcCliError("desktop app not running"));
    });
    socket.once("end", () => {
      if (!settled) rejectOnce(new DohcCliError("desktop app closed the connection"));
    });
  });
}

type RequestForVerb<Verb extends CliVerb> = Extract<CliRequest, { verb: Verb }>;

export async function sendCliRequest<Verb extends CliVerb>(
  requestWithoutToken: Omit<RequestForVerb<Verb>, "token"> | CliRequestWithoutToken,
  options: CliClientOptions = {},
): Promise<CliResultByVerb[Verb]> {
  const platform = options.platform ?? process.platform;
  const automaticDiscovery = options.stateDir === undefined;
  const endpoints = automaticDiscovery
    ? (await Promise.all(
        endpointCandidates(options, platform).map((candidate) =>
          resolveEndpoint(candidate, platform)),
      )).filter((endpoint): endpoint is CliEndpoint => endpoint !== null)
    : [await locateCliEndpoint(options)];
  if (endpoints.length === 0) throw new DohcCliError("desktop app not running");

  for (let index = 0; index < endpoints.length; index += 1) {
    const endpoint = endpoints[index]!;
    try {
      const token = await readToken(endpoint.tokenPath);
      const request: CliRequest = cliRequestSchema.parse({ ...requestWithoutToken, token });
      const rawResponse = await (options.transport ?? readResponseLine)(
        endpoint.socketPath,
        JSON.stringify(request),
        options.timeoutMs,
      );
      const responseVersion = responseVersionEnvelopeSchema.safeParse(rawResponse);
      if (!responseVersion.success) {
        throw new DohcCliError("desktop app returned an invalid response");
      }
      if (responseVersion.data.protocolVersion !== CLI_PROTOCOL_VERSION) {
        throw new DohcCliError("CLI/app version mismatch — restart the app");
      }
      const response = cliTransportResponseSchema.safeParse(rawResponse);
      if (!response.success) throw new DohcCliError("desktop app returned an invalid response");
      if (!response.data.ok) throw new DohcCliError(response.data.error);
      try {
        return parseCliResult(request.verb as Verb, response.data.result);
      } catch {
        throw new DohcCliError("desktop app returned an invalid response");
      }
    } catch (error) {
      const canTryNext = automaticDiscovery &&
        index < endpoints.length - 1 &&
        error instanceof DohcCliError &&
        error.message === "desktop app not running";
      if (!canTryNext) throw error;
    }
  }
  throw new DohcCliError("desktop app not running");
}
