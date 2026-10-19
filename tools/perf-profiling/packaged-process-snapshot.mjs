// The macOS counterpart of packaged-process-snapshot.ps1: the app process and its descendants,
// with CPU time from ps and private bytes as the kernel's physical footprint, which Activity
// Monitor reports as Memory. macOS has no per-process IO transfer counters, so those stay absent.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// ps prints CPU time as [[dd-]hh:]mm:ss.cc.
export function parseCpuTime(text) {
  const [days, clock] = text.includes('-') ? text.split('-') : ['0', text];
  return clock.split(':').reduce((total, part) => total * 60 + Number(part), 0) * 1000 + Number(days) * 86400000;
}

export function parseMacProcessSnapshot({ ps, commands, executables, footprint, appPid, startedAtMs, completedAtMs }) {
  const rows = ps.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s*$/);
    return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), cpuMs: parseCpuTime(match[3]), workingSetBytes: Number(match[4]) * 1024, createdAt: new Date(match[5]).toISOString() }] : [];
  });
  const owned = new Set([appPid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (owned.has(row.parentPid) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; }
  }
  const column = text => new Map(text.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+) (.*)$/);
    return match ? [[Number(match[1]), match[2]]] : [];
  }));
  const commandLines = column(commands), paths = column(executables);
  const footprints = new Map([...footprint.matchAll(/\[(\d+)\]: .*?Footprint: (\d+) B/g)].map(match => [Number(match[1]), Number(match[2])]));
  return { startedAtMs, completedAtMs, processes: rows.filter(row => owned.has(row.pid)).map(row => {
    const path = paths.get(row.pid) ?? null;
    return { ...row, name: path?.split('/').at(-1) ?? null, path, commandLine: commandLines.get(row.pid) ?? null, privateBytes: footprints.get(row.pid) ?? null };
  }) };
}

export async function snapshotMacProcesses(appPid, { signal } = {}) {
  const startedAtMs = Date.now();
  const run = async args => (await exec(args[0], args.slice(1), { signal, timeout: 30000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } })).stdout;
  const ps = await run(['ps', '-axo', 'pid=,ppid=,time=,rss=,lstart=']);
  const owned = parseMacProcessSnapshot({ ps, commands: '', executables: '', footprint: '', appPid, startedAtMs, completedAtMs: startedAtMs }).processes.map(row => String(row.pid));
  const pids = owned.join(',');
  const [commands, executables, footprint] = await Promise.all([
    run(['ps', '-ww', '-o', 'pid=,args=', '-p', pids]),
    run(['ps', '-ww', '-o', 'pid=,comm=', '-p', pids]),
    // A process that exits between the listing and footprint is reported without private bytes.
    run(['footprint', '--noCategories', '-f', 'bytes', ...owned.flatMap(pid => ['-p', pid])]).catch(() => ''),
  ]);
  return parseMacProcessSnapshot({ ps, commands, executables, footprint, appPid, startedAtMs, completedAtMs: Date.now() });
}
