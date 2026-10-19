// Keeps the verification queue service running on a Mac, as queue-supervisor.ps1 does on Windows.
// launchd starts this supervisor at login and again whenever it exits. It starts the service, and starts it
// again when it exits or its heartbeat stops. Each time, it first stops everything the last service started,
// and it starts no service until that succeeds.
//
// launchd stops only a job's process group, and the verifier starts every command in a session of its own
// (process.mjs), so neither launchd nor a group kill reaches the commands. Instead each service instance runs
// with a marker in its environment, which every process it starts inherits whatever its session, group,
// parent, or working directory. The procenv helper (procenv.c), which install builds into the queue root, finds
// the processes whose environment holds that exact entry. macOS hides the environment of Apple's own programs,
// such as /bin/sh, so the supervisor also records each process below the service, with its start time, once a
// second. The marker and that record live in service-tree.json, so a supervisor that launchd had to kill leaves
// them to the next one.
//
// Install copies this file to the queue root, so it imports only Node's own modules.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { uptime } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

/** The environment variable that names the service instance a process belongs to. */
export const instanceVariable = "DOHC_VERIFICATION_SERVICE_INSTANCE";
/** The environment variable that names the request a verifier and everything it starts belong to. */
export const requestVariable = "DOHC_VERIFICATION_REQUEST";
/** The environment entry that marks a process as one of a service instance's, or one of a request's. */
export const instanceMarker = id => `${instanceVariable}=${id}`;
export const requestMarker = id => `${requestVariable}=${id}`;

// Every read of the process table has a deadline, so a hung read can never leave processes stopped.
const readTimeoutMs = 10_000;
const ps = args => execFileSync("ps", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: readTimeoutMs, env: { ...process.env, LC_ALL: "C" } });

/** The processes on this host as `{ pid, ppid, start, zombie }`. A pid with another start is another process. */
export function processTable(text = ps(["-A", "-o", "pid=,ppid=,stat=,lstart="])) {
  return text.split("\n").flatMap(line => {
    const row = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]{8}\s+\d{4})\s*$/u.exec(line);
    return row ? [{ pid: Number(row[1]), ppid: Number(row[2]), zombie: row[3].startsWith("Z"), start: row[4].replace(/\s+/gu, " ") }] : [];
  });
}

/** The procenv helper in a queue root. */
export const envHelper = root => join(root, "procenv");

/**
 * Build the procenv helper at `target` with the system cc, replacing any helper there only once the build succeeds.
 * It is /usr/bin/cc, never a cc found on PATH, which under pnpm starts with a checkout's node_modules/.bin.
 */
export function buildEnvHelper(target, source = fileURLToPath(new URL("./procenv.c", import.meta.url))) {
  const built = spawnSync("/usr/bin/cc", ["-O2", "-Wall", "-o", `${target}.tmp`, source], { encoding: "utf8", timeout: 120_000 });
  if (built.status !== 0) {
    rmSync(`${target}.tmp`, { force: true });
    throw new Error(`cc could not build the procenv helper, which reads process environments exactly: ${(built.stderr || built.error?.message || "").trim()}. Install the Xcode Command Line Tools with xcode-select --install, then install again.`);
  }
  renameSync(`${target}.tmp`, target);
}

/** The pids whose environment holds exactly `marker`, such as `instanceMarker(id)`, as an entry. */
export function markedPids(marker, helper) {
  return new Set(execFileSync(helper, [marker], { encoding: "utf8", timeout: readTimeoutMs }).split("\n").filter(Boolean).map(Number));
}

/**
 * The processes that belong to a service instance or a request, as a map of pid to start time: each process in
 * `marked`, each process in `known` (a map of pid to start time) still running under the same start, and every
 * descendant of those. Neither launchd nor this process is ever one.
 */
export function members(table, marked = new Set(), known = new Map()) {
  const own = row => row.pid > 1 && row.pid !== process.pid;
  const found = new Map(table.filter(row => own(row) && (marked.has(row.pid) || known.get(row.pid) === row.start)).map(row => [row.pid, row.start]));
  for (let grew = true; grew;) {
    grew = false;
    for (const row of table) {
      if (!own(row) || found.has(row.pid) || !found.has(row.ppid)) continue;
      found.set(row.pid, row.start);
      grew = true;
    }
  }
  return found;
}

/**
 * Stop every process of a service instance or a request: those whose environment holds `marker`, read by
 * `helper`, those in `known`, and their descendants. Each round stops the members it finds with SIGSTOP, so none
 * can start another process or exit unseen, then reads them again: a stopped process cannot exit, so its pid
 * now names it for certain. One whose start time changed is another process, and gets SIGCONT; one that only
 * dropped its marker, by running another program, is still the same process. Rounds repeat until one finds no
 * new member; then every stopped member gets SIGKILL. If anything fails midway, the members already confirmed
 * get SIGKILL and the others SIGCONT, so no process stays stopped. Resolves with the members' pids once none runs.
 */
export async function stopProcesses({ marker = null, helper = null, known = new Map(), table = () => processTable(),
  marked = () => marker ? markedPids(marker, helper) : new Set(), signal = (pid, name) => process.kill(pid, name), timeoutMs = 15_000 }) {
  const send = (pid, name) => { try { signal(pid, name); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
  const stopped = new Map();
  // Stopped but not yet confirmed as members.
  const pending = new Map();
  try {
    for (let round = 0; ; round += 1) {
      if (round > 100) throw new Error("the service's processes kept changing while they were stopped");
      const rows = table();
      const fresh = [...members(rows, marked(), new Map([...known, ...stopped]))].filter(([pid]) => !stopped.has(pid));
      if (!fresh.length) break;
      for (const [pid, start] of fresh) if (send(pid, "SIGSTOP")) pending.set(pid, start);
      const now = new Map(table().map(row => [row.pid, row]));
      for (const [pid, start] of pending) {
        const row = now.get(pid);
        pending.delete(pid);
        if (row && row.start === start) stopped.set(pid, start);
        else if (row) send(pid, "SIGCONT");
      }
    }
  } finally {
    for (const pid of pending.keys()) { try { send(pid, "SIGCONT"); } catch { /* Gone or not ours. */ } }
    for (const pid of stopped.keys()) { try { send(pid, "SIGKILL"); } catch { /* Gone or not ours. */ } }
  }
  for (const deadline = Date.now() + timeoutMs; ;) {
    const left = table().filter(row => !row.zombie && stopped.get(row.pid) === row.start);
    if (!left.length) return [...stopped.keys()];
    if (Date.now() > deadline) throw new Error(`processes ${left.map(row => row.pid).join(", ")} did not stop after SIGKILL`);
    await sleep(50);
  }
}

const bootedAt = () => Date.now() - uptime() * 1000;

export const treePath = root => join(root, "service-tree.json");
/** Present while the supervisor could not stop the last service's processes, so no service runs. */
export const heldPath = root => join(root, "supervisor-held.json");

const writeFile = (path, value) => { writeFileSync(`${path}.tmp`, JSON.stringify(value) + "\n"); renameSync(`${path}.tmp`, path); };

/** Record a service instance's marker and processes for the next cleanup, so readers see the old or the new record. */
export const writeTree = (root, instance, known) => writeFile(treePath(root), { at: Date.now(), bootedAt: bootedAt(), instance, processes: [...known] });

/**
 * Stop every process of the last recorded service instance. A record from before the computer restarted names
 * nothing that still runs, so it is ignored. The record stays until the stop succeeds, and a failed stop throws,
 * so the next try finds the same processes.
 */
export async function stopRecorded(root, options = {}) {
  let record = null;
  try { record = JSON.parse(readFileSync(treePath(root), "utf8")); } catch { /* No record, or a torn one. */ }
  if (!record || Math.abs(record.bootedAt - bootedAt()) > 60_000) { rmSync(treePath(root), { force: true }); return []; }
  const stopped = await stopProcesses({ marker: instanceMarker(record.instance), helper: envHelper(root), known: new Map(record.processes), ...options });
  rmSync(treePath(root), { force: true });
  return stopped;
}

/**
 * Hold a Unix socket name for this process; the OS frees it when the process dies. Resolves with the server, or
 * null when another live process holds it. A socket file outlives a killed holder, so one that nothing answers is replaced.
 */
export async function holdSocket(path) {
  const listen = () => new Promise((done, fail) => {
    const server = createServer(socket => socket.end());
    server.once("error", fail);
    server.listen(path, () => { server.removeListener("error", fail); server.unref(); done(server); });
  });
  try { return await listen(); }
  catch (error) { if (error.code !== "EADDRINUSE") throw error; }
  const answered = await new Promise(done => {
    const socket = connect(path);
    socket.once("connect", () => { socket.destroy(); done(true); });
    socket.once("error", fault => done(fault.code !== "ECONNREFUSED" && fault.code !== "ENOENT"));
  });
  if (answered) return null;
  rmSync(path, { force: true });
  try { return await listen(); }
  catch (error) { if (error.code === "EADDRINUSE") return null; throw error; }
}

/**
 * Run the service under this supervisor until `signal` aborts or a signal stops the supervisor.
 * `stopLast` replaces stopping the last recorded service's processes, and `retryMs` the first wait before trying again, for tests.
 */
export async function supervise(root, { pollMs = 1000, beatEvery = 5, quietBeats = 24, stopLast = stopRecorded, retryMs = 5000, signal: abort } = {}) {
  root = resolve(root);
  const logPath = join(root, "supervisor.log");
  const log = line => {
    try {
      if (existsSync(logPath) && statSync(logPath).size > 5 * 1024 * 1024) renameSync(logPath, `${logPath}.1`);
      appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
    } catch { /* The log is a record; losing a line must not stop the service. */ }
  };
  // One supervisor per queue root.
  const lock = await holdSocket(join(root, "supervisor.sock"));
  if (!lock) return;
  let stopping = false;
  let wake = () => {};
  const stop = () => { stopping = true; wake(); };
  if (abort) abort.addEventListener("abort", stop, { once: true });
  else for (const name of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(name, stop);
  const pause = ms => new Promise(done => { const timer = setTimeout(done, ms); wake = () => { clearTimeout(timer); done(); }; });
  // Stop the last service's processes, trying again until it succeeds. No service starts meanwhile, so none shares the lanes with them.
  const cleanUp = async what => {
    for (let wait = retryMs; ; wait = Math.min(wait * 2, 60_000)) {
      try {
        const stopped = await stopLast(root);
        rmSync(heldPath(root), { force: true });
        if (stopped.length) log(`stopped ${stopped.length} process(es) ${what}`);
        return true;
      } catch (error) {
        log(`could not stop everything ${what}: ${error.message}. No service starts until they stop; trying again in ${Math.round(wait / 1000)} s`);
        try { writeFile(heldPath(root), { at: new Date().toISOString(), reason: error.message }); } catch { /* The log says it too. */ }
      }
      if (stopping) return false;
      await pause(wait);
      if (stopping) return false;
    }
  };
  log(`supervisor ${process.pid} started for ${root}`);
  // launchd stops only this supervisor when it kills it, so the last service and its commands may still run.
  if (!await cleanUp("the last service left")) stopping = true;
  let backoff = 5;
  while (!stopping) {
    let current = null;
    let reason = "exited";
    let code = null;
    let errors = "";
    const started = Date.now();
    try {
      current = readFileSync(join(root, "current"), "utf8").trim();
      const service = join(root, "service", current);
      const id = randomUUID();
      // A group of its own keeps the service alive when launchd kills this supervisor's group, so the next supervisor stops it in order.
      const child = spawn(process.execPath, [join(service, "scripts", "verification", "queue-service.mjs"), "--supervised", "--root", root],
        { cwd: service, detached: true, stdio: ["pipe", "ignore", "pipe"], env: { ...process.env, [instanceVariable]: id } });
      const exited = new Promise(done => { child.once("exit", (exit, signal) => done({ exit, signal })); child.once("error", error => done({ error })); });
      child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-4096); });
      child.stdin.on("error", () => {});
      // The record names the instance before the service may start anything.
      let known = new Map();
      const row = processTable().find(candidate => candidate.pid === child.pid);
      if (row) known = new Map([[row.pid, row.start]]);
      writeTree(root, id, known);
      child.stdin.end("go\n");
      // Apple's programs hide their environment, so each process below the service is recorded by its start time too.
      const follow = () => {
        const found = members(processTable(), new Set(), known);
        if (found.size !== known.size || [...found].some(([pid, start]) => known.get(pid) !== start)) writeTree(root, id, found);
        known = found;
      };
      let lastBeat = null;
      let quiet = 0;
      for (let tick = 1; ; tick += 1) {
        const outcome = await Promise.race([exited, pause(pollMs).then(() => null)]);
        if (outcome) { code = outcome.exit ?? outcome.signal ?? null; if (outcome.error) reason = `failed to start: ${outcome.error.message}`; break; }
        if (stopping) { reason = "stopped with the supervisor"; break; }
        // A failed reading of the process table keeps the last record; it is no reason to stop the service.
        try { follow(); } catch (error) { log(`could not read the process table: ${error.message}`); }
        // Polls without a new heartbeat, not wall-clock age: a timer does not advance while the machine sleeps,
        // so a service that just woke is never mistaken for a hung one.
        if (tick % beatEvery) continue;
        let seen = lastBeat;
        try { seen = existsSync(join(root, "service.json")) ? statSync(join(root, "service.json")).mtimeMs : null; } catch { /* Read as unchanged. */ }
        if (seen !== lastBeat) { lastBeat = seen; quiet = 0; } else quiet += 1;
        if (quiet >= quietBeats) { reason = `heartbeat stopped for ${quietBeats} polls`; break; }
      }
    } catch (error) {
      reason = `failed to start: ${error.message}`;
    }
    // A service that failed prints why last; a killed one printed only its runs' output.
    const why = typeof code === "number" && code !== 0 && code !== 75 ? errors.trim() : "";
    log(`service ${current} ${reason} (exit ${code})${why ? `\n${why}` : ""}`);
    if (!await cleanUp(`that service ${current} started`) || stopping) break;
    if (code === 75) { backoff = 5; continue; }
    if (Date.now() - started > 10 * 60_000) backoff = 5;
    await pause(backoff * 1000);
    backoff = Math.min(backoff * 2, 60);
  }
  log(`supervisor ${process.pid} stopped`);
  abort?.removeEventListener("abort", stop);
  lock.close();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--root");
  if (index < 0 || !process.argv[index + 1]) throw new Error("Use --root <queue root>.");
  supervise(process.argv[index + 1]).then(() => process.exit(0), error => { console.error(error.stack ?? error.message); process.exit(1); });
}
