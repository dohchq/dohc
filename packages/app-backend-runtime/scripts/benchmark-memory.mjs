import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

/** One sampler process for the run. It receives only task-owned PIDs over stdin. */
export async function startMemorySampler({path,pids,onSample,intervalMs=250}) {
  if (!Number.isSafeInteger(intervalMs)||intervalMs<100||intervalMs>5000)throw new Error('Invalid sampler interval.');
  const script=String.raw`$ErrorActionPreference='Stop'
$taskPids=@()
Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Threading;
public static class SamplerInput {
  public static readonly ConcurrentQueue<string> Lines = new ConcurrentQueue<string>();
  public static void Start() { new Thread(() => { string line; while((line=Console.ReadLine())!=null) Lines.Enqueue(line); Lines.Enqueue("{\"stop\":true}"); }) { IsBackground=true }.Start(); }
}
'@
[SamplerInput]::Start()
$running=$true
while($running){
  $line=''
  while([SamplerInput]::Lines.TryDequeue([ref]$line)){
    $command=ConvertFrom-Json -InputObject $line
    if($command.stop){$running=$false;break}
    $taskPids=@($command.pids)
  }
  if(-not $running){break}
  $samples=@(foreach($taskPid in $taskPids){
    try{$taskProcess=[System.Diagnostics.Process]::GetProcessById([int]$taskPid);$taskProcess.Refresh()
      @{pid=$taskProcess.Id;workingSetBytes=$taskProcess.WorkingSet64;privateBytes=$taskProcess.PrivateMemorySize64;peakWorkingSetBytes=$taskProcess.PeakWorkingSet64;cpuMs=$taskProcess.TotalProcessorTime.TotalMilliseconds}
      $taskProcess.Dispose()
    }catch [System.ArgumentException]{}catch [System.InvalidOperationException]{}
  })
  [Console]::Out.WriteLine((@{at=[DateTime]::UtcNow.ToString('o');processes=$samples}|ConvertTo-Json -Compress -Depth 4))
  Start-Sleep -Milliseconds ${intervalMs}
}`;
  const child=spawn('pwsh',['-NoProfile','-NonInteractive','-Command',script],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const output=createWriteStream(path,{flags:'wx'}),lines=createInterface({input:child.stdout});
  let errors='',firstResolve,firstReject,count=0,stopping=false,failure;
  const first=new Promise((resolve,reject)=>{firstResolve=resolve;firstReject=reject;});
  const fail=error=>{failure??=error;firstReject(error);};
  child.stdout.pipe(output);child.stderr.on('data',chunk=>{errors+=chunk.toString();});
  lines.on('line',line=>{try{const sample=JSON.parse(line);count++;onSample(sample);if(pids.every(pid=>sample.processes.some(item=>item.pid===pid)))firstResolve();}catch(error){fail(error);}});
  child.on('error',fail);child.stdin.on('error',fail);output.on('error',fail);
  const exited=once(child,'exit').then(([code])=>{if(!stopping||code!==0)throw new Error(`Memory sampler exited ${code}: ${errors}`);});
  void exited.catch(fail);
  const update=values=>{if(!failure&&!stopping)child.stdin.write(JSON.stringify({pids:values})+'\n');};
  const timer=setTimeout(()=>firstReject(new Error('Memory sampler startup timed out.')),10000);
  try{update(pids);await first;}catch(error){stopping=true;child.kill();await exited.catch(()=>{});output.destroy();throw error;}finally{clearTimeout(timer);}
  return {pid:child.pid,intervalMs,update,
    async stop(){stopping=true;const timer=setTimeout(()=>child.kill(),5000);try{child.stdin.end(JSON.stringify({stop:true})+'\n');await exited;if(failure)throw failure;await new Promise((resolve,reject)=>{if(output.writableFinished)return resolve();output.once('finish',resolve);output.once('error',reject);});return {samples:count,intervalMs};}finally{clearTimeout(timer);}},
  };
}
