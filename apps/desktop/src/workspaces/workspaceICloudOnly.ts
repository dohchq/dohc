import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { basename, join } from "node:path";

// With Optimize Mac Storage, iCloud Drive can keep a file's bytes only in
// iCloud and leave a dataless file on disk. Moved into .dohc/local, which
// iCloud Drive skips, such a file could leave iCloud with nothing on disk
// behind it. Only a Mac puts that mark on .dohc/local, so only a Mac checks.

/** The macOS st_flags bit of a file whose bytes are not on disk. */
export const SF_DATALESS = 0x40000000;

/**
 * Where the check runs, what it may spend, and how it reads st_flags. It runs
 * while the workspace is held, so it stops at either bound. Tests change these.
 */
export const iCloudCheck = {
  applies: process.platform === "darwin",
  maxEntries: 100_000,
  maxMs: 10_000,
  readFlags: readFlagsWithStat,
};

type Problem = "whole" | "part" | "too-large" | "unchecked";

const BECAUSE: Record<Problem, string> = {
  whole: "it is only in iCloud Drive",
  part: "some of it is only in iCloud Drive",
  "too-large": "it holds too many files to check",
  unchecked: "dohc could not check for files only in iCloud Drive",
};
const FIX: Record<Problem, string> = {
  whole: "Download it, then try again.",
  part: "Download it, then try again.",
  "too-large": "Delete it in smaller parts.",
  unchecked: "Try again.",
};

/** dohc did not move an entry into the workspace trash, because of what is, or may be, only in iCloud Drive. */
export class ICloudCheckRefusal extends Error {
  readonly because: string;
  constructor(entry: string, readonly problem: Problem) {
    super(`dohc did not move ${entry} to the workspace trash because ${BECAUSE[problem]}. ${FIX[problem]}`);
    this.name = "ICloudCheckRefusal";
    this.because = BECAUSE[problem];
  }
}

// A size and no blocks is cheap to see, but a local sparse or compressed file
// looks the same, so only a candidate's dataless flag decides.
const candidate = (stats: Stats) => stats.isFile() && stats.size > 0 && stats.blocks === 0;

/**
 * Refuses, with ICloudCheckRefusal, an entry that is or holds a file only in
 * iCloud Drive, or one it can't check within its bounds. Reads names, sizes
 * and flags only, so nothing is downloaded.
 */
export async function refuseOnlyInICloud(target: string): Promise<void> {
  if (!iCloudCheck.applies) return;
  const { maxEntries, maxMs, readFlags } = iCloudCheck;
  const deadline = performance.now() + maxMs;
  const overdue = () => performance.now() > deadline;
  const refusal = (problem: Problem) => new ICloudCheckRefusal(basename(target), problem);
  const top = await lstat(target);
  const candidates: string[] = [];
  if (candidate(top)) candidates.push(target);
  if (top.isDirectory()) {
    let seen = 0;
    const folders = [target];
    for (let folder = folders.pop(); folder !== undefined; folder = folders.pop()) {
      // An empty folder lists nothing, so its open is checked here.
      if (overdue()) throw refusal("too-large");
      const files: string[] = [];
      for await (const entry of await opendir(folder)) {
        if (++seen > maxEntries || overdue()) throw refusal("too-large");
        const path = join(folder, entry.name);
        if (entry.isDirectory()) folders.push(path);
        else if (entry.isFile()) files.push(path);
      }
      for (let at = 0; at < files.length; at += 64) {
        const batch = files.slice(at, at + 64);
        const stats = await Promise.all(batch.map(path => lstat(path)));
        stats.forEach((entry, index) => { if (candidate(entry)) candidates.push(batch[index]!); });
        if (overdue()) throw refusal("too-large");
      }
    }
  }
  // An answer that came late is no answer.
  if (overdue()) throw refusal(top.isDirectory() ? "too-large" : "unchecked");
  if (!candidates.length) return;
  let flags: readonly number[];
  try {
    flags = await readFlags(candidates, deadline - performance.now());
  } catch {
    throw refusal("unchecked");
  }
  if (flags.length !== candidates.length) throw refusal("unchecked");
  if (flags.some(value => (value & SF_DATALESS) !== 0)) throw refusal(top.isFile() ? "whole" : "part");
}

// Each path's st_flags, in order, from /usr/bin/stat, because Node does not
// expose them. No shell; the paths go in batches well under ARG_MAX. A path
// that vanished makes stat fail, and so does the whole read.
export async function readFlagsWithStat(paths: readonly string[], timeoutMs: number): Promise<number[]> {
  const deadline = performance.now() + timeoutMs;
  const flags: number[] = [];
  for (let at = 0; at < paths.length;) {
    const batch: string[] = [];
    for (let bytes = 0; at < paths.length && batch.length < 1_000 && bytes < 64 * 1024; at += 1) {
      batch.push(paths[at]!);
      bytes += Buffer.byteLength(paths[at]!) + 1;
    }
    const timeout = Math.floor(deadline - performance.now());
    if (timeout <= 0) throw new Error("No time left to read file flags.");
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile("/usr/bin/stat", ["-f", "%Xf", "--", ...batch], { timeout, encoding: "utf8" },
        (error, out) => (error ? reject(error) : resolve(out)));
    });
    const lines = stdout.split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (lines.length !== batch.length || !lines.every(line => /^[0-9a-f]+$/iu.test(line))) {
      throw new Error("stat answered for other files.");
    }
    flags.push(...lines.map(line => Number.parseInt(line, 16)));
  }
  return flags;
}
