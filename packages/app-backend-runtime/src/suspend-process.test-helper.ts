import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as pause } from "node:timers/promises";

function deferred<T>() {
  let resolve!:(value:T)=>void,reject!:(error:Error)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}

// A hang guard, not a performance assertion. The six-second stop is the test stimulus.
async function guarded<T>(result:Promise<T>,step:string):Promise<T> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    return await Promise.race([result,new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>reject(new Error(`Suspend helper timed out ${step}.`)),60_000);
    })]);
  } finally {clearTimeout(timer);}
}

export function processSuspender() {
  if(process.platform!=="win32") {
    const cancel=new AbortController();
    let stopped:Promise<number>|undefined;
    return {
      ready:Promise.resolve(),
      failed:new Promise<never>(()=>{}),
      suspend(pid:number) {
        return stopped=(async()=>{
          process.kill(pid,"SIGSTOP");
          let resumedAt:number;
          try {await pause(6_000,undefined,{signal:cancel.signal});}
          catch(error) {if(!cancel.signal.aborted) throw error;}
          finally {resumedAt=Date.now();process.kill(pid,"SIGCONT");}
          return resumedAt;
        })();
      },
      async close() {cancel.abort();await stopped?.catch(()=>{});},
    };
  }

  // One helper owns the handle and the entire stop. Closing stdin also releases
  // the pause, so cleanup never depends on a separate resume command.
  const script=`
$ErrorActionPreference='Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SuspendHelper {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")] static extern int NtSuspendProcess(IntPtr handle);
  [DllImport("ntdll.dll")] static extern int NtResumeProcess(IntPtr handle);
  static void Check(int status, string operation) {
    if(status < 0) throw new Exception(operation + " failed: NTSTATUS 0x" + status.ToString("X8"));
  }
  public static long Stop(int pid) {
    IntPtr handle=OpenProcess(0x0800, false, pid);
    if(handle==IntPtr.Zero) throw new Exception("OpenProcess failed: Win32 " + Marshal.GetLastWin32Error());
    try {
      Check(NtSuspendProcess(handle), "NtSuspendProcess");
      long resumedAt;
      try {System.Threading.Tasks.Task.Run(()=>Console.In.ReadLine()).Wait(6000);}
      finally {
        resumedAt=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        Check(NtResumeProcess(handle), "NtResumeProcess");
      }
      return resumedAt;
    } finally {CloseHandle(handle);}
  }
}
'@
  [Console]::Out.WriteLine('ready')
  $target=[Console]::In.ReadLine()
  if($null -ne $target) {
    $resumedAt=[SuspendHelper]::Stop([int]$target)
    [Console]::Out.WriteLine("resumed $resumedAt")
  }
} catch {[Console]::Error.WriteLine($_.Exception.ToString()); exit 1}
`;
  const child=spawn("powershell.exe",["-NoProfile","-NonInteractive","-Command",script],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
  const ready=deferred<void>(),finished=deferred<number>(),failed=deferred<never>();
  let stderr="",resumedAt:number|undefined,requested=false;
  const fail=(error:Error)=>{ready.reject(error);finished.reject(error);failed.reject(error);};
  child.stderr.setEncoding("utf8").on("data",chunk=>{stderr+=chunk;});
  child.on("error",fail);child.stdin.on("error",fail);
  const lines=createInterface({input:child.stdout});
  lines.on("line",line=>{
    if(line==="ready") ready.resolve();
    else if(/^resumed \d+$/.test(line)) resumedAt=Number(line.slice(8));
    else fail(new Error(`Suspend helper said: ${line}`));
  });
  const exited=new Promise<void>(resolve=>child.on("close",(code,signal)=>{
    if(code!==0 || (requested && resumedAt===undefined)) fail(new Error(`Suspend helper exited (${signal ?? code}): ${stderr.trim() || "no resume acknowledgement"}`));
    else if(resumedAt!==undefined) finished.resolve(resumedAt);
    else fail(new Error("Suspend helper exited before suspension."));
    lines.close();resolve();
  }));
  // Failures can arrive before the caller reaches either await.
  void ready.promise.catch(()=>{});void finished.promise.catch(()=>{});void failed.promise.catch(()=>{});
  return {
    ready:guarded(ready.promise,"waiting for ready"),
    failed:failed.promise,
    suspend(pid:number) {
      requested=true;child.stdin.write(`${pid}\n`);
      return guarded(finished.promise,"waiting for resume");
    },
    async close() {
      child.stdin.end();
      try {await guarded(exited,"waiting for cleanup");}
      finally {if(child.exitCode===null && child.signalCode===null) child.kill();}
    },
  };
}
