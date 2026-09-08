import {mkdtempSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,it} from "vitest";
import {readOwnerAdmissionConfig} from "./ownerAdmissionConfig.js";

it("requires a bounded explicit owner share map and every validation budget",() => {
  const root = mkdtempSync(join(tmpdir(),"dohc-owner-admission-")), path = join(root,"config.json");
  const validation = {maxStructVisits: 100,maxValueNodeVisits: 100,maxDecodedPayloadByteVisits: 1000,maxStructClientGroupVisits: 100,
    maxDeleteClientGroupVisits: 100,maxDeleteIntervalVisits: 100,maxIndexOperations: 100};
  const value = {version: 1,shares: [{workspaceId: "workspace",shareId: "share"}],validation,maxEntriesPerDrain: 10,
    maxBytesPerDrain: 10_000,maxDocumentsPerPass: 10,pollIntervalMs: 100,passDeadlineMs: 1000};
  const read = (input: unknown) => {writeFileSync(path,JSON.stringify(input)); return readOwnerAdmissionConfig(path,["workspace"]);};
  expect(read(value).admission.shares).toEqual(new Map([["workspace","share"]]));
  for (const bad of [{...value,shares: []},{...value,shares: [...value.shares,...value.shares]},
    {...value,shares: [{workspaceId: "unknown",shareId: "share"}]},{...value,validation: {...validation,maxIndexOperations: undefined}},
    {...value,validation: {...validation,defaultBudget: 10}},{...value,maxEntriesPerDrain: undefined},
    ...[0,-1,1.5,2_147_483_648].map(pollIntervalMs => ({...value,pollIntervalMs})),{...value,extra: true}]) expect(() => read(bad)).toThrow();
  expect(() => readOwnerAdmissionConfig("relative.json",["workspace"])).toThrow("absolute");
  expect(() => readOwnerAdmissionConfig(join(root,"missing.json"),["workspace"])).toThrow();
  writeFileSync(path," ".repeat(1_048_577)); expect(() => readOwnerAdmissionConfig(path,["workspace"])).toThrow("too large");
});
