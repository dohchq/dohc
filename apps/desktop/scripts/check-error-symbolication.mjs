#!/usr/bin/env node

// Release owners run this before a release that sends error reports, to
// prove PostHog resolves main and window frames through the uploaded source
// maps. electron-builder packages only dist/**, so this script never ships.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, SourceMap } from "node:module";
import { homedir, release, tmpdir, type, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const CHUNK_ID = /\n\/\/# chunkId=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/;
// The snippet `posthog-cli sourcemap inject` writes names the release.
const RELEASE_ID = /\._posthogReleaseId=\w+\._posthogReleaseId\|\|"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/;
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
// The channel and dist the check's reports carry, so nobody takes them for a person's.
export const LABEL = "release-check";
// A project the app's checks accept. A dry run never sends to it.
const DRY_RUN_PROJECT = { key: "phc_releasecheckdryrun", host: "https://posthog.invalid" };

/**
 * The main script and the window's entry script of the package, each with
 * a generated position its source map ties to dohc's own source. Each
 * script must match the build's file byte for byte, and that file's source
 * map must carry the script's chunk ID.
 */
export function probeTargets(archive, dist) {
  const { main } = JSON.parse(extract(archive, "package.json").toString("utf8"));
  if (typeof main !== "string" || !/^dist\/main\/[\w.-]+\.js$/.test(main)) {
    throw new Error("The package.json in app.asar names no main script under dist/main.");
  }
  const page = extract(archive, "dist/renderer/index.html").toString("utf8");
  const script = /<script\b[^>]*\bsrc="\.\/(assets\/[\w.-]+\.js)"/.exec(page)?.[1];
  if (!script) throw new Error("dist/renderer/index.html in app.asar loads no script from assets.");
  return [target("main", main, archive, dist), target("renderer", `dist/renderer/${script}`, archive, dist)];
}

function target(part, path, archive, dist) {
  const shipped = extract(archive, path);
  const built = join(dist, ...path.split("/").slice(1));
  const fromBuild = (file, read) => {
    try {
      return read(file);
    } catch {
      throw new Error(`Cannot read ${file}. Use the dist folder of the build that made this package.`);
    }
  };
  if (!shipped.equals(fromBuild(built, readFileSync))) {
    throw new Error(`${path} in app.asar differs from ${built}. Use the dist folder of the build that made this package.`);
  }
  const code = shipped.toString("utf8");
  const chunkId = CHUNK_ID.exec(code)?.[1];
  if (!chunkId) throw new Error(`${path} carries no chunk ID, so its source map was not uploaded.`);
  const map = fromBuild(`${built}.map`, (file) => JSON.parse(readFileSync(file, "utf8")));
  if (map.chunk_id !== chunkId) {
    throw new Error(`${built}.map belongs to chunk ${map.chunk_id ?? "none"}, not to ${chunkId} in app.asar.`);
  }
  const position = ownPosition(map);
  const entry = position && new SourceMap(map).findEntry(position.line, position.column);
  if (!entry || entry.generatedLine !== position.line || entry.generatedColumn !== position.column) {
    throw new Error(`${built}.map ties no position in ${path} to dohc's own source.`);
  }
  return {
    part,
    path,
    chunkId,
    code,
    releaseId: RELEASE_ID.exec(code)?.[1] ?? null,
    // V8 counts lines and columns from 1; source maps count them from 0.
    generated: { line: position.line + 1, column: position.column + 1 },
    original: { source: entry.originalSource, line: entry.originalLine + 1, column: entry.originalColumn + 1 },
  };
}

function extract(archive, path) {
  // @electron/asar splits a path on the platform's separator.
  return asar.extractFile(archive, join(...path.split("/")));
}

// The first generated position, counted from 0, that the map ties to a
// source outside node_modules.
function ownPosition(map) {
  const own = map.sources.map((source) => !/(^|\/)node_modules\//.test(source));
  const state = [0, 0, 0, 0];
  for (const [line, text] of map.mappings.split(";").entries()) {
    state[0] = 0;
    for (const segment of text.split(",")) {
      if (!segment) continue;
      const fields = vlq(segment);
      for (let index = 0; index < Math.min(fields.length, 4); index += 1) state[index] += fields[index];
      if (fields.length >= 4 && own[state[1]]) return { line, column: state[0] };
    }
  }
  return null;
}

function vlq(segment) {
  const values = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = BASE64.indexOf(char);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
    } else {
      values.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = 0;
      shift = 0;
    }
  }
  return values;
}

/**
 * Builds one main and one window error at the targets' positions and hands
 * them to dohc's own report code: createTelemetry, errorReport and the
 * posthog-node sender. A dry run stops each request before it leaves. With
 * `send`, the two reports go to the project DOHC_POSTHOG_KEY and
 * DOHC_POSTHOG_HOST name, and the check passes only when both requests got a
 * 2xx answer.
 */
export async function runProbes({ archive, dist, send = false, env = process.env, fetch = globalThis.fetch }) {
  archive = resolve(archive);
  const targets = probeTargets(archive, resolve(dist));
  const { version } = JSON.parse(extract(archive, "package.json").toString("utf8"));
  const project = send ? { key: env.DOHC_POSTHOG_KEY ?? "", host: env.DOHC_POSTHOG_HOST ?? "" } : DRY_RUN_PROJECT;
  const { createCodeLocations, createTelemetry, resolveReporting } = await reportCode();
  const reporting = resolveReporting({
    build: { posthogKey: project.key, posthogHost: project.host, dist: LABEL },
    packaged: true,
    env,
    argv: [],
  });
  if (!reporting?.errors) {
    throw new Error(send
      ? "Set DOHC_POSTHOG_KEY and DOHC_POSTHOG_HOST to a PostHog project, and unset DOHC_TELEMETRY and DO_NOT_TRACK."
      : "DOHC_TELEMETRY or DO_NOT_TRACK turns reports off in this environment.");
  }
  // The folder the package is installed in, as main's code roots name it.
  const root = resolve(archive, "..", "..");
  const privateText = [root, homedir(), `/${userInfo().username}/`, `\\${userInfo().username}\\`]
    .flatMap((text) => [text, text.replaceAll("\\", "/"), JSON.stringify(text).slice(1, -1)]);
  const requests = [];

  const guarded = async (url, init) => {
    const body = String(init?.body ?? "");
    const event = JSON.parse(body).batch?.[0];
    const top = event?.properties?.$exception_list?.[0]?.stacktrace?.frames?.find((frame) => frame.chunk_id);
    const request = { target: targets.find((candidate) => candidate.chunkId === top?.chunk_id), event, status: null, problem: null };
    requests.push(request);
    if (!String(url).startsWith(`${reporting.errors.host}/`)) request.problem = `The SDK asked for ${url}, outside the project.`;
    else if (privateText.some((text) => body.includes(text))) request.problem = "The report held a path from this computer.";
    else if (!request.target) request.problem = "The report holds no frame in the checked scripts.";
    else if (top.filename !== `app:///${request.target.path}` || top.lineno !== request.target.generated.line
      || top.colno !== request.target.generated.column) request.problem = "The report's frame is not the checked position.";
    if (request.problem) throw new Error(request.problem);
    if (!send) throw new Error("Dry run: not sent.");
    const response = await fetch(url, init);
    request.status = response.status;
    return response;
  };

  const state = mkdtempSync(join(tmpdir(), "dohc-release-check-"));
  const releaseBefore = globalThis._posthogReleaseId;
  try {
    // The injected snippet sets this when the shipped main script loads.
    globalThis._posthogReleaseId = targets[0].releaseId ?? undefined;
    const telemetry = createTelemetry({
      reporting,
      statePath: join(state, "reporting.json"),
      facts: () => ({
        atMs: Date.now(), version, channel: LABEL, os: type(), osVersion: release(), arch: process.arch, electron: LABEL,
      }),
      locate: createCodeLocations([root], process.platform),
      readCode: async (path) => {
        const match = targets.find((candidate) => path.replaceAll("\\", "/").endsWith(`/app.asar/${candidate.path}`));
        if (!match) throw new Error(`The check reads only its two scripts, not ${path}.`);
        return match.code;
      },
      fetch: guarded,
    });
    // The person who runs the check asked for these two reports.
    telemetry.acknowledgeNotice({ usage: false, errors: true });
    telemetry.setPrivacy({ usageReports: false, errorReports: true });
    const [main, renderer] = targets;
    const frame = (probe, file) => `Error: ${LABEL}\n    at releaseCheck (${file}:${probe.generated.line}:${probe.generated.column})`;
    const mainError = new Error(LABEL);
    mainError.stack = frame(main, join(archive, ...main.path.split("/")));
    telemetry.reportError({ kind: "crash", event: { kind: "main-exception", error: mainError, origin: "uncaughtException" } });
    telemetry.reportError({
      kind: "renderer",
      origin: "uncaught",
      error: { name: "Error", stack: frame(renderer, pathToFileURL(join(archive, ...renderer.path.split("/"))).href) },
    });
    await telemetry.flush();
  } finally {
    globalThis._posthogReleaseId = releaseBefore;
    rmSync(state, { recursive: true, force: true });
  }

  const events = targets.map((probe) => {
    const request = requests.find((candidate) => candidate.target === probe);
    const ok = send ? request?.status !== null && request?.status >= 200 && request?.status < 300 : Boolean(request);
    return {
      part: probe.part,
      file: `app:///${probe.path}`,
      chunkId: probe.chunkId,
      generated: `${probe.generated.line}:${probe.generated.column}`,
      expected: `${probe.original.source}:${probe.original.line}:${probe.original.column}`,
      eventId: request?.event?.uuid ?? null,
      releaseId: request?.event?.properties?.$release_id ?? null,
      status: request?.status ?? null,
      problem: request?.problem ?? (request ? (ok ? null : "PostHog did not accept the report.") : "No report left in time."),
      payload: request?.event ?? null,
    };
  });
  return { sent: send, passed: requests.length === 2 && events.every((event) => !event.problem), events };
}

// dohc's report code, built from this checkout's source as main builds it.
async function reportCode() {
  const { build } = require("esbuild");
  const result = await build({
    stdin: {
      contents: [
        'export { createTelemetry } from "./telemetry/telemetry";',
        'export { resolveReporting } from "./telemetry/reportingConfig";',
        'export { createCodeLocations } from "./crashReports/crashReport";',
      ].join("\n"),
      resolveDir: join(desktopDir, "src"),
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  const directory = mkdtempSync(join(tmpdir(), "dohc-release-check-code-"));
  try {
    const file = join(directory, "report-code.mjs");
    writeFileSync(file, result.outputFiles[0].contents);
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { app: { type: "string" }, dist: { type: "string" }, send: { type: "boolean", default: false } },
  });
  if (!values.app || !values.dist) {
    console.error("Usage: node apps/desktop/scripts/check-error-symbolication.mjs --app <resources/app.asar> --dist <apps/desktop/dist> [--send]");
    process.exitCode = 2;
  } else {
    try {
      const result = await runProbes({ archive: values.app, dist: values.dist, send: values.send });
      console.log(JSON.stringify(result, null, 2));
      if (!result.passed) process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
