import {mkdtempSync,writeFileSync,readSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,expect,it,vi} from "vitest";
import {readDesktopOwnerHostConfig} from "./desktopOwnerHost";

vi.mock("node:fs",async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {...fs,readSync:vi.fn(fs.readSync),readFileSync:vi.fn(fs.readFileSync)};
});
const roots: string[] = [];
afterEach(() => {for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); vi.clearAllMocks();});

function fixture() {
  const root = mkdtempSync(join(tmpdir(),"dohc-owner-host-config-")); roots.push(root);
  const path = join(root,"config.json"), credentialPath = join(root,"credential.json");
  const credential = {version:1,hostId:"host",instanceId:"instance",hostEpoch:1,secret:"A".repeat(43)};
  const config = {version:1,nativeConfigPath:join(root,"native.json"),credentialPath,url:"wss://owner.test",workspaceIds:["workspace"],reconnectDelayMs:1000,
    control:{maxConnections:2,maxHeaderBytes:4096,maxCredentialBytes:1024,maxPayloadBytes:4096,maxPendingBytes:2_000_000,
      maxFragments:16,maxBufferedChunks:16,handshakeTimeoutMs:1000,heartbeatIntervalMs:1000,heartbeatTimeoutMs:1000,closeTimeoutMs:1000},
    transport:{aggregateBytes:200_000_000,maxAdoptionBytes:1_000_000,maxAdoptionEvents:10,maxFrameBytes:1_048_576,
      maxQueuedBytes:2_000_000,maxRegistrations:10,maxUploads:2,requestDeadlineMs:30_000}};
  writeFileSync(credentialPath,JSON.stringify(credential));
  const write = () => writeFileSync(path,JSON.stringify(config)); write();
  return {path,credentialPath,credential,config,write};
}

it.each(["reconnectDelayMs","requestDeadlineMs"] as const)("rejects %s values that overflow a Node timer",field => {
  const f = fixture();
  const target = field === "reconnectDelayMs" ? f.config : f.config.transport;
  for (const value of [0,-1,1.5,2_147_483_648,Number.MAX_SAFE_INTEGER]) {
    Object.assign(target,{[field]:value}); f.write(); expect(() => readDesktopOwnerHostConfig(f.path)).toThrow();
  }
  Object.assign(target,{[field]:2_147_483_647}); f.write(); expect(() => readDesktopOwnerHostConfig(f.path)).not.toThrow();
});

it.each(["config","credential"] as const)("bounds %s reads before allocating the entire file",kind => {
  const f = fixture(), limit = kind === "config" ? 1_048_576 : 16_384;
  const path = kind === "config" ? f.path : f.credentialPath;
  const json = JSON.stringify(kind === "config" ? f.config : f.credential);
  writeFileSync(path,json.padEnd(limit," "));
  expect(() => readDesktopOwnerHostConfig(f.path)).not.toThrow();
  vi.clearAllMocks();
  writeFileSync(path,json.padEnd(limit*4," "));
  expect(() => readDesktopOwnerHostConfig(f.path)).toThrow("too large");
  expect(readFileSync).not.toHaveBeenCalled();
  const reads = vi.mocked(readSync).mock.results.filter(result => result.type === "return").map(result => result.value as number);
  expect(reads.reduce((total,length) => total+length,0)).toBeLessThanOrEqual(limit+1+(kind === "credential" ? JSON.stringify(f.config).length : 0));
});

it("keeps restore forwarding disabled unless its explicit bound is valid",()=>{
  const f=fixture();
  expect(readDesktopOwnerHostConfig(f.path).transport.maxRestoreBytes).toBeUndefined();
  for(const maxRestoreBytes of [0,4,-1,1.5,64*1024*1024+1,0x1_0000_0000]){
    Object.assign(f.config.transport,{maxRestoreBytes});f.write();
    expect(()=>readDesktopOwnerHostConfig(f.path)).toThrow("transport budget");
  }
  Object.assign(f.config.transport,{maxRestoreBytes:1_000_000});f.write();
  expect(readDesktopOwnerHostConfig(f.path).transport.maxRestoreBytes).toBe(1_000_000);
});

it("enables sync forwarding only with bounded vectors, outputs and aggregate copy space", () => {
  const f = fixture();
  expect(readDesktopOwnerHostConfig(f.path).transport.sync).toBeUndefined();
  const sync = {maxClientVectorBytes: 1024, maxOutputBytes: 1_000_000};
  Object.assign(f.config.transport, {sync}); f.write();
  expect(readDesktopOwnerHostConfig(f.path).transport.sync).toEqual(sync);
  const required = 1024 * 3 + 1_000_000 * 3 + f.config.transport.maxFrameBytes * 4;
  f.config.transport.aggregateBytes = required - 1; f.write();
  expect(() => readDesktopOwnerHostConfig(f.path)).toThrow("sync aggregate budget");
  f.config.transport.aggregateBytes = required; f.write();
  expect(() => readDesktopOwnerHostConfig(f.path)).not.toThrow();
  for (const bad of [null, {}, {...sync, maxClientVectorBytes: 0}, {...sync, maxOutputBytes: 2},
    {...sync, maxOutputBytes: 64 * 1024 * 1024 + 1}, {...sync, extra: true}]) {
    Object.assign(f.config.transport, {sync: bad}); f.write();
    expect(() => readDesktopOwnerHostConfig(f.path)).toThrow();
  }
});

it("refuses impossible aggregate budgets at config read",()=>{
  const f=fixture();
  Object.assign(f.config.transport,{maxRestoreBytes:1_000_000,aggregateBytes:9_194_303});f.write();
  expect(()=>readDesktopOwnerHostConfig(f.path)).toThrow("transport budget");
  f.config.transport.aggregateBytes++;f.write();expect(()=>readDesktopOwnerHostConfig(f.path)).not.toThrow();
  f.config.transport.maxAdoptionBytes=2_000_000;f.write();
  expect(()=>readDesktopOwnerHostConfig(f.path)).toThrow("transport budget");
});

it.each([4096, 1_500_000])("requires queue space for the advertised payload and native frame (%i)", maxPayloadBytes => {
  const f = fixture();
  f.config.control.maxPayloadBytes = maxPayloadBytes;
  const minimum = Math.max(maxPayloadBytes + 16, f.config.transport.maxFrameBytes + 36);
  f.config.transport.maxQueuedBytes = minimum - 1; f.write();
  expect(() => readDesktopOwnerHostConfig(f.path)).toThrow("transport budget");
  f.config.transport.maxQueuedBytes = minimum; f.write();
  expect(() => readDesktopOwnerHostConfig(f.path)).not.toThrow();
});
