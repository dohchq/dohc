// Producer evidence for the verification lane's queue tickets.
//
// build-slot.mjs removes a ticket as soon as it claims a lane, so an
// uncontended admission finishes before an outside sampler can see it. The
// verifier therefore reads each ticket it publishes, synchronously and before
// that ticket attempts admission, and keeps the exact bytes beside its receipt.
// Reads are sequential: an observation records what this producer read, not an
// atomic snapshot of the queue, the process table, and the receipt.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function queryWindowsProcess(pid) {
  return execFileSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object ProcessId,ParentProcessId,Name,@{n='CreationTimeUtc';e={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress`],
  { encoding: "utf8", windowsHide: true, timeout: 60_000 });
}

/**
 * The live OS identity of `pid`, including the creation time Windows records for
 * it. Elsewhere, or when the lookup fails, CreationTimeUtc is null and
 * `unavailable` says why; a creation time is never inferred.
 */
export function processIdentity({ pid = process.pid, platform = process.platform, query = queryWindowsProcess } = {}) {
  const requestedAt = new Date().toISOString();
  if (platform !== "win32") return { ProcessId: pid, CreationTimeUtc: null, requestedAt, unavailable: `Creation-time identity is recorded only on win32, not ${platform}.` };
  try {
    const rows = [].concat(JSON.parse(query(pid) || "[]"));
    const [row] = rows;
    if (rows.length !== 1 || row?.ProcessId !== pid || typeof row.CreationTimeUtc !== "string" || !Number.isFinite(Date.parse(row.CreationTimeUtc))) {
      throw new Error(`Win32_Process did not return one identity with a creation time for pid ${pid}.`);
    }
    return { ProcessId: row.ProcessId, ParentProcessId: row.ParentProcessId, Name: row.Name, CreationTimeUtc: row.CreationTimeUtc,
      source: "Win32_Process.CreationDate", requestedAt, observedAt: new Date().toISOString() };
  } catch (error) {
    return { ProcessId: pid, CreationTimeUtc: null, requestedAt, unavailable: error.message };
  }
}

/**
 * Evidence for the tickets one verification run publishes. Pass `observe` as
 * build-slot's observeTicket: it retains each ticket's bytes and observation
 * under `<output>/ticket-evidence`, then persists `record`. Any failure throws,
 * so acquisition rejects instead of admitting without evidence. After
 * acquisition settles, `settle` records whether each observed ticket is gone
 * and returns a failure message when one survives or cannot be checked.
 */
export function ticketEvidence({ output, checkout, commit, producer, persist }) {
  const directory = join(output, "ticket-evidence");
  const record = { schema: "dohc-verification-ticket-evidence-v1", checkout, commit, producer, observations: [], cleanup: [] };
  function observe({ root, kind, name, path }) {
    const readStartedAt = new Date().toISOString();
    const bytes = readFileSync(path);
    const readFinishedAt = new Date().toISOString();
    const text = bytes.toString("utf8");
    const index = record.observations.length + 1;
    const file = `${String(index).padStart(2, "0")}-${name}`;
    const observation = { schema: "dohc-verification-ticket-observation-v1", meaning: "producer-before-admission", index,
      queueRoot: root, kind, ticket: name, path, readStartedAt, readFinishedAt, bytes: bytes.length, sha256: sha256(bytes),
      text, payload: JSON.parse(text), payloadFile: `ticket-evidence/${file}`, checkout, commit, producer };
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, file), bytes, { flag: "wx" });
    if (sha256(readFileSync(join(directory, file))) !== observation.sha256) throw new Error(`The retained copy of ${name} differs from the bytes read.`);
    const observationText = JSON.stringify(observation, null, 2) + "\n";
    writeFileSync(join(directory, `${file}.observation.json`), observationText, { flag: "wx" });
    record.observations.push({ index, kind, ticket: name, path, payloadFile: observation.payloadFile, sha256: observation.sha256,
      observationFile: `ticket-evidence/${file}.observation.json`, observationSha256: sha256(observationText) });
    persist();
  }
  function settle() {
    record.cleanup = record.observations.map(({ index, ticket, path }) => {
      const checkedAt = new Date().toISOString();
      try {
        lstatSync(path);
        return { index, ticket, path, checkedAt, state: "present" };
      } catch (error) {
        return error.code === "ENOENT" ? { index, ticket, path, checkedAt, state: "absent" }
          : { index, ticket, path, checkedAt, state: "unreadable", error: error.message };
      }
    });
    const failed = record.cleanup.filter(entry => entry.state !== "absent");
    return failed.length ? `Verification ticket cleanup is unverified: ${failed.map(entry => `${entry.ticket} is ${entry.state}`).join("; ")}.` : null;
  }
  return { record, observe, settle };
}
