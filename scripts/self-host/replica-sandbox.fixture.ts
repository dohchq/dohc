import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {existsSync, readFileSync} from "node:fs";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {createServer} from "node:http";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {Duplex} from "node:stream";
import {EngineClient, DuplexEngineClientConnection, decodeReplicaCurrentView} from "../../packages/workspace-engine-client/src/daemon/index";
import {createSyncRelayHandler} from "../../services/sync-relay/src/server";
import {openSyncRelayStorage} from "../../services/sync-relay/src/storage";
import {createReplicaReadPrincipal} from "../../services/sync-relay/src/replicaReadPrincipal";
import {createReplicaEngineStarter} from "../../services/sync-relay/src/replicaEngine";
import {createReplicaSupervisor} from "../../services/sync-relay/src/replicaSupervisor";
import {startPublicationOperator} from "../../services/sync-relay/src/appPublicationOperator";
import {serveReplicaRelay} from "../../services/sync-relay/src/replicaRelaySocket";

const engineExecutable = "/app/engine";
const root = await mkdtemp("/tmp/replica-proof-");
const storage = openSyncRelayStorage(join(root, "relay.sqlite"));
await mkdir("/replicas", {recursive: true, mode: 0o700});
await mkdir("/replicas/sibling", {recursive: true});
await writeFile("/replicas/sibling/secret", "another workspace");
await writeFile("/data/secret", "relay-only secret");
storage.claimWorkspace({workspaceId: "w", ownerUserId: "owner@dohc.test", createdAtMs: 1});
storage.createShare({share: {shareId: "share", workspaceId: "w", granterUserId: "owner@dohc.test", selectorJson: '{"paths":[],"versionId":"main"}', createdAtMs: 1},
  grant: {grantId: "grant", shareId: "share", principalKind: "user", principalUserId: "reader@dohc.test", principalEmail: null,
    access: "view", generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null}});
const principal = createReplicaReadPrincipal(storage);
const samples: Record<string, unknown>[] = [];
let logCursor = 0;
const selectors = [{versionId: "main", paths: []}];

function command(executable: string, args: string[], cwd: string, timeout = 15_000) {
  return new Promise<{code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string}>((resolve, reject) => {
    const child = spawn(executable, args, {cwd, env: {}, stdio: ["ignore", "pipe", "pipe"]});
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => {stdout += chunk;}); child.stderr.on("data", chunk => {stderr += chunk;});
    const timer = setTimeout(() => {child.kill("SIGKILL"); reject(Error(`probe timeout: ${args}`));}, timeout);
    child.once("error", reject); child.once("close", (code, signal) => {clearTimeout(timer); resolve({code, signal, stdout, stderr});});
  });
}

async function probes() {
  const store = await mkdtemp("/replicas/probe-");
  const socket = await serveReplicaRelay(store, {bearer: "probe-lease"} as Parameters<typeof serveReplicaRelay>[1],
    async request => new Response("own lease", {status: new URL(request.url).pathname === "/sync/w/bootstrap" ? 200 : 404}));
  const sibling = await serveReplicaRelay("/replicas/sibling", {bearer: "other-lease"} as Parameters<typeof serveReplicaRelay>[1],
    async () => new Response("another lease"));
  const tcp = createServer((_, response) => response.end("relay"));
  tcp.listen(1788, "0.0.0.0"); await once(tcp, "listening");
  let signals = 0, takedowns = 0;
  const onSignal = () => {signals++;}; process.on("SIGUSR2", onSignal);
  const secretPath = "/continuity/publication-operator.secret", operatorPath = "/tmp/proof-operator/control.sock";
  const operator = await startPublicationOperator({disableAppPublication: input => {
    takedowns++; return {publicationId: input.publicationId, authorityRevision: 2,
      operatorTakedown: {actor: "operator" as const, disabledAtMs: input.nowMs, reason: input.reason}};
  }}, operatorPath, secretPath);
  try {
    for (const action of ["async-fcntl", "async-ioctl", "setown-ex", "setsig", "siocspgrp"]) {
      const before = signals;
      const baselineSignal = action.startsWith("async-") ? once(process, "SIGUSR2", {signal: AbortSignal.timeout(5000)}) : undefined;
      const baseline = await command("/app/probe-baseline", [action, "sandbox", String(process.pid)], store);
      assert.equal(baseline.code, 0, JSON.stringify(baseline)); await baselineSignal;
      if (action.startsWith("async-")) assert(signals > before, `${action}: baseline did not signal`);
      samples.push({action: `${action}-baseline`, baseline});
      const controlBefore = signals;
      const controlSignal = action.startsWith("async-") ? once(process, "SIGUSR2", {signal: AbortSignal.timeout(5000)}) : undefined;
      const control = await command("/app/probe", [action, "control", String(process.pid)], store);
      assert.equal(control.code, 0, JSON.stringify(control)); await controlSignal;
      if (action.startsWith("async-")) assert(signals > controlBefore, `${action}: no signal delivered`);
      const count = signals;
      const sandbox = await command("/app/probe", [action, "sandbox", String(process.pid)], store);
      assert.equal(sandbox.code, 13, JSON.stringify(sandbox)); assert.equal(signals, count);
      samples.push({action, control, sandbox});
    }
    const control = await command("/app/probe", ["operator", "control", String(process.pid), operatorPath, secretPath], store);
    assert.equal(control.code, 0, JSON.stringify(control)); assert.equal(takedowns, 1);
    const sandbox = await command("/app/probe", ["operator", "sandbox", String(process.pid), operatorPath], store);
    assert.equal(sandbox.code, 13, JSON.stringify(sandbox)); assert.match(sandbox.stdout, /authentication failed/); assert.equal(takedowns, 1);
    const secret = await command("/app/probe", ["operator-secret", "sandbox", String(process.pid), secretPath], store);
    assert.equal(secret.code, 13); samples.push({action: "operator", control, sandbox, secret});
    // Read before restriction. A confined child cannot read this table at all.
    const table = readFileSync("/proc/net/unix", "utf8");
    for (const line of table.trim().split("\n").slice(1)) {
      const path = line.trim().split(/\s+/)[7];
      if (path) assert(path.startsWith("/replicas/") || path === operatorPath, `unexpected Unix listener: ${line}`);
    }
    const denied = ["data", "environ", "sibling", "proc-unix", "tcp", "postgres", "dns", "udp", "internet", "chmod", "xattr", "truncate", "kill", "kill-group", "tgkill",
      "prlimit", "priority", "scheduler", "ptrace", "io-uring", "bpf", "ipc", "fork", "exec", "as", "fsize", "nofile"];
    for (const action of denied) {
      const address = action === "tcp" ? "127.0.0.1:1788" : "postgres:5432";
      const control = await command("/app/probe", [action, "control", String(process.pid), address], store);
      await rm(join(store, "oversize"), {force: true});
      const sandbox = await command("/app/probe", [action, "sandbox", String(process.pid), address], store);
      assert(sandbox.code !== 0, `${action} escaped: ${JSON.stringify(sandbox)}`);
      assert.equal(sandbox.stderr, "", `${action} failed to apply sandbox: ${sandbox.stderr}`);
      if (!["ptrace", "io-uring", "bpf"].includes(action)) assert.equal(control.code, action === "exec" ? 42 : 0, `${action} control: ${JSON.stringify(control)}`);
      samples.push({action, control, sandbox});
    }
    for (const [action, expected] of [["get", 200], ["post", 404], ["wrong-lease", 404], ["wrong-path", 404], ["sibling-socket", 404]] as const) {
      const result = await command("/app/probe", [action, "sandbox", String(process.pid), sibling.socketPath], store);
      assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, new RegExp(`HTTP/1.1 ${expected}`));
      samples.push({action, result});
    }
    for (const [action, expected] of [["core", "core=0"], ["nice", "nice=10"]] as const) {
      const result = await command("/app/probe", [action, "sandbox", String(process.pid)], store);
      assert.equal(result.code, 0, result.stderr); assert(result.stdout.includes(expected)); samples.push({action, result});
    }
    // Exercise the production CPU hard limit. The control terminates itself after 126 CPU seconds.
    for (const mode of ["control", "sandbox"]) {
      const result = await command("/app/probe", ["cpu", mode, String(process.pid)], store, 360_000);
      console.log(JSON.stringify({action: "cpu", mode, result}));
      if (mode === "sandbox") assert.equal(result.signal, "SIGKILL", JSON.stringify(result));
      else assert.equal(result.code, 0, JSON.stringify(result));
      samples.push({action: "cpu", mode, result});
    }
    process.kill(process.pid, 0);
  } finally {process.off("SIGUSR2", onSignal); await operator.close(); await socket.close(); await sibling.close(); tcp.closeAllConnections(); await new Promise<void>(resolve => tcp.close(() => resolve())); await rm(store, {recursive: true, force: true});}
}

async function seedOwner() {
  const dir = join(root, "owner"); await mkdir(dir);
  const ownerRoute = createSyncRelayHandler({storage, resolveActor: (_request, workspaceId) => ({userId: "owner@dohc.test", workspaceId}),
    resolveUserIdByEmail: email => email, lookupVerifiedUserEmail: userId => userId, lookupUserEmail: userId => userId,
    linkKey: "local-replica-proof-key-at-least-thirty-two-bytes", shareWebOrigin: "http://localhost",
    relayExchangeKey: "local-replica-proof-exchange-at-least-thirty-two-bytes"});
  const enrollment = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const response = await ownerRoute(new Request(`http://localhost${incoming.url}`, {method: incoming.method,
        headers: incoming.headers as Record<string, string>, ...(chunks.length ? {body: Buffer.concat(chunks)} : {})}));
      const bytes = Buffer.from(await response.arrayBuffer());
      if (response.status >= 400) console.error("owner relay", incoming.url, response.status, bytes.toString());
      outgoing.writeHead(response.status, {...Object.fromEntries(response.headers), "content-length": bytes.length}); outgoing.end(bytes);
    } catch (error) {outgoing.writeHead(500); outgoing.end(String(error));}
  });
  enrollment.listen(0, "127.0.0.1"); await once(enrollment, "listening");
  const address = enrollment.address(); assert(address && typeof address !== "string");
  const child = spawn(engineExecutable, [], {cwd: dir, env: {DOHC_ENGINE_AUTH_TOKEN: "owner"}, stdio: ["pipe", "pipe", "pipe"]});
  const exited = once(child, "close").then(() => {});
  const client = new EngineClient(new DuplexEngineClientConnection(Duplex.from({readable: child.stdout, writable: child.stdin})),
    {authToken: "owner", protocolVersion: 2, capabilities: ["blobs"], connectTimeoutMs: 30_000}, () => child.kill("SIGKILL"), exited);
  child.stderr.on("data", chunk => process.stderr.write(chunk)); child.on("close", (code, signal) => client.notifyProcessExit(code, signal));
  let id = 1, workspace: string | undefined;
  const rpc = async (method: string, params: Record<string, unknown>) => {try {return (await client.sendRequest({id: id++, method, workspace, deadlineMs: 30_000, params: params as never})).result as Record<string, unknown>;} catch (error) {console.error("owner RPC", method); throw error;}};
  try {
    await client.ready(); workspace = String((await rpc("workspace.open", {rootDir: dir, workspaceId: "w", captureMode: "none", recoverRunningDispatches: false,
      relay: {baseUrl: `http://127.0.0.1:${address.port}`, bearerToken: "owner", allowInsecureLoopbackForTests: true}})).workspace);
    await rpc("versions.ensureMain", {});
    await rpc("sync.claim", {workspaceId: "w", accountId: "owner@dohc.test"});
    for (let file = 0; file < 4; file++) await rpc("versionedText.write", {versionId: "main", path: `sample-${file}.txt`, text: `file ${file}\n` + "local replica data\n".repeat(2048),
      momentId: `seed-${file}`, origin: "api", publish: true});
    let pushed: Record<string, unknown>;
    do {pushed = await rpc("sync.push", {workspaceId: "w"});} while (pushed.hasMore);
    logCursor = storage.readReplicaStanding("w")!.logSeq;
    assert(logCursor > 0, "owner published canonical rows");
  } finally {client.close(); child.kill("SIGKILL"); await exited; enrollment.closeAllConnections(); await new Promise<void>(resolve => enrollment.close(() => resolve()));}
}

async function ordinaryFixture() {
  const storeDir = await mkdtemp("/replicas/real-");
  const lease = principal.issue("w", "real");
  const child = await createReplicaEngineStarter({engineExecutable, allowDevelopment: true})({storeDir, lease, relayHandler: principal.handle});
  try {
    await child.pull();
    const db = new DatabaseSync(join(storeDir, ".dohc/engine/engine.db"), {readOnly: true});
    try {assert.equal(db.prepare("SELECT log_cursor FROM replica_frontiers").get()!.log_cursor, logCursor);}
    finally {db.close();}
    const page = await child.currentView(selectors, []); assert.equal(page.logCursor, logCursor); assert.equal(page.files.length, 4, JSON.stringify(page));
    samples.push({action: "real-engine", logCursor: page.logCursor, files: page.files.length});
  } finally {await child.close(); principal.revoke(lease); await rm(storeDir, {recursive: true, force: true});}
}

async function hostile() {
  for (const mode of ["endless", "corrupt", "frame", "disk", "unlinked"] as const) {
    let store = "", childPid: number | undefined;
    const errors: string[] = [];
    const supervisor = createReplicaSupervisor({storage, storeRoot: "/replicas", minFreeBytes: mode === "unlinked" ? 48*1024*1024 : 1024, maxStoreBytes: mode === "disk" ? 1024*1024 : 32*1024*1024,
      diskCheckMs: 10, onError: (_, error) => errors.push(String(error)), startChild: async input => {
        store = input.storeDir;
        if (mode === "unlinked") {
          const processChild = spawn("/app/probe", ["unlinked", "sandbox", String(process.pid)], {cwd: store, env: {}, stdio: ["ignore", "pipe", "pipe"]});
          childPid = processChild.pid; const exited = once(processChild, "close").then(() => {});
          processChild.stdout.resume(); processChild.stderr.resume();
          return {exited, close: async () => {processChild.kill("SIGKILL"); await exited;}, currentView: async () => {throw Error("no view");},
            pull: async () => {await exited; throw Error("unlinked writer stopped");}};
        }
        if (mode === "frame") {
          const processChild = spawn(engineExecutable, ["--replica"], {cwd: store, env: {DOHC_ENGINE_AUTH_TOKEN: "probe"}, stdio: ["pipe", "pipe", "pipe"]});
          childPid = processChild.pid;
          const exited = once(processChild, "close").then(() => {});
          processChild.stdout.resume(); processChild.stderr.resume();
          return {exited, close: async () => {processChild.kill("SIGKILL"); await exited;}, currentView: async () => {throw Error("no view");},
            pull: async () => {const header = Buffer.alloc(12); header.write("DOP1"); header[4] = 1; header.writeUInt32LE(0xffff_ffff, 8); processChild.stdin.end(header); await exited; throw Error("oversized frame refused");}};
        }
        const child = await createReplicaEngineStarter({engineExecutable, allowDevelopment: true, deadlineMs: 2500})({...input, relayHandler: async request => {
          if (new URL(request.url).pathname.endsWith("/log")) {
            if (mode === "endless") return new Response(new ReadableStream({start(controller) {controller.enqueue(Buffer.from('{"ops":['));}}));
          }
          if (mode === "corrupt" && /\/blobs\//.test(new URL(request.url).pathname)) return new Response("corrupt update bytes");
          return input.relayHandler(request);
        }});
        childPid = child.pid;
        if (mode === "disk") {
          const pull = child.pull.bind(child);
          return {...child, pull: async () => {await pull(); await writeFile(join(store, "too-big"), Buffer.alloc(2*1024*1024));}};
        }
        return child;
      }});
    try {
      await assert.rejects(supervisor.activate("w")); await supervisor.settled("w");
      assert(!existsSync(store), `${mode}: retired store remains`); assert(childPid);
      assert.throws(() => process.kill(childPid!, 0), /ESRCH/); process.kill(process.pid, 0);
      assert(errors.length, `${mode}: no reported failure`); if (mode === "unlinked") assert(errors.some(e => e.includes("free space")), errors.join("\n")); samples.push({action: mode, errors});
    } finally {await supervisor.close();}
  }
}

// Control is the sandbox policy at 49a3b174a; both binaries use identical runtime settings.
async function measure() {
  const results: {sandbox: boolean; pull: number; cut: number}[] = [];
  for (let pair = -1; pair < 31; pair++) {
    for (const sandbox of pair % 2 === 0 ? [true, false] : [false, true]) {
      const store = await mkdtemp("/replicas/bench-");
      const lease = principal.issue("w", "bench");
      const socket = await serveReplicaRelay(store, lease, principal.handle);
      const child = spawn(sandbox ? "/app/engine" : "/app/control", ["--replica"], {cwd: store, env: {DOHC_ENGINE_AUTH_TOKEN: "bench", TMPDIR: store}, stdio: ["pipe", "pipe", "pipe"]});
      const exited = once(child, "close").then(() => {});
      const client = new EngineClient(new DuplexEngineClientConnection(Duplex.from({readable: child.stdout, writable: child.stdin})),
        {authToken: "bench", protocolVersion: 2, capabilities: ["blobs"], connectTimeoutMs: 10_000}, () => child.kill("SIGKILL"), exited);
      child.stderr.on("data", chunk => process.stderr.write(chunk)); child.on("close", (code, signal) => client.notifyProcessExit(code, signal));
      let id = 1, workspace: string | undefined;
      const rpc = async (method: string, params: Record<string, unknown>) => (await client.sendRequest({id: id++, method, workspace, deadlineMs: 10_000, params: params as never})).result as Record<string, unknown>;
      try {
        await client.ready();
        workspace = String((await rpc("workspace.open", {rootDir: store, workspaceId: "w", storeMode: "passive", captureMode: "none", recoverRunningDispatches: false,
          relay: {socketPath: socket.socketPath, bearerToken: lease.bearer}})).workspace);
        await rpc("sync.adoptJoinIdentity", {workspaceId: "w", ...storage.getWorkspaceIdentity("w")!});
        const start = performance.now(), page = await rpc("sync.pull", {workspaceId: "w"});
        await rpc("sync.commitCursor", {workspaceId: "w", pendingCursor: page.pendingCursor});
        const pull = performance.now() - start, cutStart = performance.now();
        const cut = decodeReplicaCurrentView(await rpc("replica.cut", {selectors, incarnation: lease.incarnation, knownTextShas: "", position: null, cursor: null}));
        assert.equal(cut.logCursor, logCursor); assert.equal(cut.files.length, 4); const cutMs = performance.now() - cutStart;
        if (pair >= 0) results.push({sandbox, pull, cut: cutMs});
      } finally {client.close(); child.kill("SIGKILL"); await exited; await socket.close(); principal.revoke(lease); await rm(store, {recursive: true, force: true});}
    }
  }
  const summary = [false, true].map(sandbox => ({sandbox, ...Object.fromEntries(["pull", "cut"].map(key => {
    const sorted = results.filter(r => r.sandbox === sandbox).map(r => r[key as "pull" | "cut"]).sort((a, b) => a-b);
    return [key, {median: sorted[15], p95: sorted[29]}];
  }))}));
  samples.push({action: "measure", comparison: "49a3b174a policy versus fixed policy", pairs: 31, fixture: "four 38 KiB text files; fresh store; complete pull and cut", summary, results});
}

try {
  if (process.argv.includes("--probes")) await probes();
  await seedOwner(); await ordinaryFixture(); await hostile();
  if (process.argv.includes("--measure")) await measure();
  console.log(JSON.stringify({result: "PASS", samples}));
} finally {storage.close(); await rm(root, {recursive: true, force: true});}
