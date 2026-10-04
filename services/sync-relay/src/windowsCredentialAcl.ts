import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";

// A Windows path holds at most 32,767 UTF-16 code units, which also bounds each request line.
const requestTimeoutMs = 10_000, stderrLimitBytes = 1024 * 1024, pathLimit = 32_767;

export interface WindowsCredentialAcl {
  check(path: string, directory: boolean, create: boolean, final: boolean): Promise<void>;
  close(): Promise<void>;
}

// One credential operation owns at most one Windows PowerShell child. Each request reruns `check` against
// the path's current ACL, and the final request also requires a clean exit within its deadline. Any other
// outcome stops this child and refuses the operation. Requests arrive on [Console]::In; never use $input.
export function openWindowsCredentialAcl(check: string): WindowsCredentialAcl {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$id = 0
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $id++
  $fields = $line.Split(' ')
  if ($fields.Count -ne 4 -or $fields[0] -cne [string]$id -or $fields[1] -notin @('0', '1') -or $fields[2] -notin @('0', '1')) { throw 'Malformed request' }
  $env:DOHC_HOST_CREDENTIAL_CREATE = $fields[1]
  $env:DOHC_HOST_CREDENTIAL_DIRECTORY = $fields[2]
  $env:DOHC_HOST_CREDENTIAL_PATH = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($fields[3]))
${check}
  [Console]::Out.WriteLine('ok ' + $id)
  [Console]::Out.Flush()
}`;
  let child: ChildProcessWithoutNullStreams | undefined, closed: Promise<unknown> = Promise.resolve(), stopped: Promise<unknown> = Promise.resolve();
  let pending: { response: string; final: boolean; answered: boolean; done(error?: Error): void } | undefined;
  let failure: Error | undefined, ended = false, sequence = 0, output = "", errors = "", errorBytes = 0;

  // The first failure stops the child once. Windows may not end it, so its close is awaited for at most one
  // request deadline.
  function fail(error: Error): Error {
    const request = pending;
    pending = undefined;
    if (!failure) {
      failure = error;
      stopped = new Promise(resolve => {
        const timer = setTimeout(resolve, requestTimeoutMs);
        void closed.then(() => { clearTimeout(timer); resolve(undefined); });
      });
      if (child) {
        for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();
        child.unref();
        try { child.kill(); } catch { /* Preserve the first failure; the bounded wait still applies. */ }
      }
    }
    request?.done(failure);
    return failure;
  }

  function start(): ChildProcessWithoutNullStreams {
    const started = spawn(join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: "pipe" });
    closed = new Promise(resolve => started.once("close", resolve));
    started.on("close", (code: number | null) => {
      if (pending?.answered && pending.final && code === 0) {
        const request = pending;
        pending = undefined;
        request.done();
      } else fail(new Error(`Credential ACL check exited with ${code}.${errors && `\n${errors}`}`));
    });
    started.on("error", fail);
    for (const stream of [started.stdin, started.stdout, started.stderr]) stream.on("error", fail);
    started.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("latin1");
      if (!pending || pending.answered || !pending.response.startsWith(output)) return fail(new Error("Unexpected credential ACL response."));
      if (output !== pending.response) return;
      output = "";
      pending.answered = true;
      if (!pending.final) {
        const request = pending;
        pending = undefined;
        request.done();
      }
    });
    started.stderr.on("data", (chunk: Buffer) => {
      errorBytes += chunk.length;
      if (errorBytes > stderrLimitBytes) fail(new Error("Credential ACL check wrote too much error output."));
      else errors += chunk.toString("utf8");
    });
    return started;
  }

  return {
    check(path, directory, create, final) {
      return new Promise<void>((resolve, reject) => {
        const settle = (error?: Error) => { clearTimeout(timer); if (error) reject(error); else resolve(); };
        // A refused request waits for its child to stop, but never past its own deadline.
        const refuse = (error: Error) => { void stopped.then(() => settle(error)); };
        const timer = setTimeout(() => settle(fail(new Error("Credential ACL check timed out."))), requestTimeoutMs);
        if (pending || ended) fail(new Error("Credential ACL checks must run one at a time before the final check."));
        // UTF-8 would silently replace an unpaired surrogate, so the child would check another name.
        else if (path.length > pathLimit || !path.isWellFormed()) fail(new Error("Invalid credential path."));
        if (failure) return refuse(failure);
        const id = ++sequence;
        pending = { response: `ok ${id}\r\n`, final, answered: false, done: error => error ? refuse(error) : settle() };
        ended = final;
        const line = `${id} ${create ? 1 : 0} ${directory ? 1 : 0} ${Buffer.from(path, "utf8").toString("base64")}\n`;
        try {
          child ??= start();
          if (final) child.stdin.end(line);
          else child.stdin.write(line);
        } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      });
    },
    async close() {
      fail(new Error("Credential ACL checks closed."));
      await stopped;
    },
  };
}
