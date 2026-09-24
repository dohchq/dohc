import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCookies } from "better-auth/cookies";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { parseDatasetDefinition } from "@dohc/security-contract/dataset";
import { UnauthorizedError } from "@dohc/workspace-auth/session";
import { compileClosedApp } from "../../../apps/desktop/src/workspaces/closedAppCompiler";
import { APP_PUBLICATION_LIMITS, prepareOwnerAppPublication } from "../../../apps/desktop/src/workspaces/ownerAppPublication";
import { openSyncRelayStorage } from "../../sync-relay/src/storage";
import type { StorageContext } from "../../sync-relay/src/storage/context";
import { createSyncRelayHandler } from "../../sync-relay/src/server";
import { hashLinkBearer } from "../../sync-relay/src/linkSecurity";
import { compileDatasetOperations } from "../../sync-relay/src/datasetCompiler";
import { createShareWebApplication } from "../src/server";
import { loadDefinition, loadSchema, loadOperations, loadFrontend } from "./publicLoadSources";

const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
export const viewerOrigin = "https://viewer.example.com";
export const syntheticReceipt = Buffer.from("%PDF-1.7 synthetic fundraiser receipt\n%%EOF");

/** Real approved compiler, publication, relay, SQLite, and isolated runtime. Only account identity is a fixture. */
export async function actualFundraiserFixture(options: {loadScenario?: "generic" | "fundraiser"; loseFirstRegisterResponse?: boolean} = {}) {
  let manifestBytes = readFileSync(new URL("../../../examples/fundraiser/app.publish.json", import.meta.url));
  const manifest = JSON.parse(manifestBytes.toString());
  const generic = options.loadScenario === "generic";
  const definition = generic ? loadDefinition : parseDatasetDefinition(JSON.parse(readFileSync(new URL("../../../examples/fundraiser/dataset.json", import.meta.url), "utf8")));
  const schemaSql = generic ? loadSchema : readFileSync(new URL("../../../examples/fundraiser/schema.sql", import.meta.url), "utf8");
  const operationSource = generic ? loadOperations : readFileSync(new URL("../../../examples/fundraiser/backend.ts", import.meta.url), "utf8");
  const revision = describeDatasetRevision({ definition, revision: 1, schemaSql, operationSource });
  if (options.loadScenario) {
    manifest.inputs = [manifest.entryPath];
    manifest.dataset = {kind: "dataset", datasetId: definition.datasetId, revision: 1, revisionSha256: revision.revisionSha256,
      operationIds: definition.operations.map(operation => operation.operationId)};
    manifestBytes = Buffer.from(JSON.stringify(manifest));
  }
  const sources = new Map<string, Uint8Array>([["fundraiser/app.publish.json", manifestBytes]]);
  // app.publish.json paths are relative to the app folder.
  for (const path of manifest.inputs as string[]) sources.set(`fundraiser/${path}`, options.loadScenario ? Buffer.from(loadFrontend) : readFileSync(new URL(`../../../examples/fundraiser/${path}`, import.meta.url)));
  const prepared = await prepareOwnerAppPublication({workspaceId:"w",appRoot:"fundraiser",shareId:"s",grantId:"g"},
    {shareId:"s",grantId:"g",generation:1,status:"active",revokedAtMs:null,selector:{paths:["fundraiser"],versionId:null}}, {
      signal: new AbortController().signal, assertCurrent() {}, compile: compileClosedApp,
      async resolveDatasetRevision() { return revision; },
      adapter: {
        async listTextFileMetadata() {
          return [...sources].map(([path,bytes])=>({path,objectId:path,contentKind:"text" as const,sha256:sha(bytes),byteLength:bytes.byteLength,binarySha256:null,
            updatedAtMs:1,latestMomentId:"fixture-source",metadataOrigin:"disk",hasYdocMarker:false}));
        },
        async captureSourceMetadata({workspaceId,versionId,paths}) {
          const files = [...paths].sort().map(path => {
            const bytes=sources.get(path);if(!bytes)throw Error(`Missing captured source ${path}`);
            return {path,objectId:path,contentKind:"text" as const,sha256:sha(bytes),byteLength:bytes.byteLength,latestMomentId:"fixture-source"};
          });
          return {workspaceId,versionId,files,totalBytes:files.reduce((n,f)=>n+f.byteLength,0),sourceDigest:sha(JSON.stringify(["dohc-source-capture-v1",workspaceId,versionId,files]))};
        },
        async hydrateCapturedSources(capture) { return capture.files.map(file=>({path:file.path,sha256:file.sha256,bytes:Uint8Array.from(sources.get(file.path)!)})); },
      },
    });
  const directory=mkdtempSync(join(tmpdir(),"dohc-fundraiser-browser-"));
  const storage=openSyncRelayStorage(join(directory,"relay.sqlite")) as StorageContext;
  const datasetHost=await storage.createDatasetHost({directory:join(directory,"workers"),limits:APP_PUBLICATION_LIMITS,
    compileOperations:compileDatasetOperations,
    onShutdownError(error){throw error;}});
  const linkKey="fundraiser-browser-link-key-with-thirty-two-bytes",exchangeKey="fundraiser-browser-relay-exchange-key-with-thirty-two-bytes";
  const secret="S".repeat(43);
  storage.claimWorkspace({workspaceId:"w",ownerUserId:"owner",createdAtMs:1});
  storage.createFileLinkShare({share:{shareId:"s",workspaceId:"w",granterUserId:"owner",selectorJson:JSON.stringify({paths:["fundraiser"],versionId:null}),createdAtMs:1},
    grant:{grantId:"g",shareId:"s",principalKind:"link",principalUserId:null,principalEmail:null,access:"view",generation:1,status:"active",createdAtMs:1,revokedAtMs:null,parentGrantId:null},
    credential:{credentialId:"credential",grantId:"g",secretHash:hashLinkBearer(secret,linkKey),generation:1,mintedAtMs:1,retiredAtMs:null},guard(){}});
  storage.tx(()=>storage.db.prepare("INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id) VALUES('helper','s','user','helper-user',NULL,'view',1,'active',1,NULL,NULL)").run());
  const accountCookie=`${getCookies({baseURL:viewerOrigin}).sessionToken.name}=synthetic-organizer-session`;
  let signedIn=false, lostRegisterResponse = false;
  const relay=createSyncRelayHandler({storage,datasetHost,appPublicationLimits:APP_PUBLICATION_LIMITS,linkKey,relayExchangeKey:exchangeKey,shareWebOrigin:viewerOrigin,
    resolveActor(request,workspaceId) {
      if(request.headers.get("authorization")==="Bearer owner")return {workspaceId,userId:"owner"};
      if(signedIn&&request.headers.get("cookie")===accountCookie)return {workspaceId,userId:"helper-user"};
      throw new UnauthorizedError();
    }});
  const owner=async(action:string,body:unknown)=>{
    const response=await relay(new Request(`https://relay.example.org/sync/w/datasets/${definition.datasetId}/${action}`,{method:"POST",headers:{authorization:"Bearer owner","content-type":"application/json"},body:JSON.stringify(body)}));
    if(!response.ok)throw Error(`Owner ${action}: ${response.status} ${await response.text()}`);return response.json();
  };
  await owner("activate",{revision,schemaSql,operationSource,capacityBytes:1024*1024});
  const publication=storage.publishAppPublication({workspaceId:"w",shareId:"s",grantId:"g",generation:1,ownerUserId:"owner",candidate:prepared.candidate,
    limits:APP_PUBLICATION_LIMITS,nowMs:Date.now(),blobs:prepared.files.map(file=>({sha256:file.sha256,bytes:file.bytes}))});
  const publicationId=publication.publicationId;
  await owner("binding",{publicationId,enabled:true});
  await owner("grants",{grantId:"helper",grant:{revision:1,revisionSha256:revision.revisionSha256,
    operationIds:definition.operations.filter(operation=>operation.access==="helper").map(operation=>operation.operationId),discover:false}});
  const calls:Array<{operation:string;status:number;named:boolean}>=[];
  const profiles = new Set<string>();
  const application=createShareWebApplication({relayUrl:"https://relay.example.org",publicRelayUrl:"https://relay.example.org",relayExchangeKey:exchangeKey,
    publicHosts:new Set(["viewer.example.com"]),newProfileSecret:()=>{const value=randomBytes(32).toString("base64url");profiles.add(value);return value;},appLaunch:{viewerOrigin,appDomain:"example.net"},
    viewerAssetsDir:fileURLToPath(new URL("../viewer/dist",import.meta.url)),accountAuth:{publicOrigin:viewerOrigin,upstreamUrl:"https://auth.example.org"},
    fetchAuth:async request=>{
      const path=new URL(request.url).pathname;
      if(path==="/api/auth/get-session")return Response.json(signedIn&&request.headers.get("cookie")===accountCookie?{user:{id:"helper-user",name:"Example Organizer"},session:{userId:"helper-user"}}:null);
      if(path==="/api/auth/sign-in/email") {
        const input=await request.json();if(input.email!=="organizer@example.test"||input.password!=="synthetic-password")return new Response(null,{status:401});
        signedIn=true;return Response.json({redirect:false,user:{id:"helper-user",name:"Example Organizer"}},{headers:{"set-cookie":accountCookie+"; Secure; HttpOnly; SameSite=Lax; Path=/"}});
      }
      return new Response(null,{status:404});
    },
    fetchRelay:async request=>{
      const body=request.method==="POST"&&new URL(request.url).pathname.endsWith("/invoke")?await request.clone().json():null;
      const response=await relay(request);if(body)calls.push({operation:body.operation,status:response.status,named:request.headers.has("cookie")});
      if (options.loseFirstRegisterResponse && body?.operation === "register" && !lostRegisterResponse) { lostRegisterResponse = true; await response.arrayBuffer(); return new Response(null, {status: 503}); }
      return response;
    },
  });
  return {application,publicationId,secret,calls,compiler:prepared.candidate.compilerIdentity,
    counts:()=>({participants:Number(storage.db.prepare("SELECT count(*) AS n FROM sync_relay_dataset_participants").get()!.n),
      profiles:profiles.size,
      receipts:Number(storage.db.prepare("SELECT count(*) AS n FROM dohc_dataset_receipts").get()!.n)}),
    field:(table:string,column:string)=>definition.tables.find(value=>value.sqlName===table)!.fields.find(field=>field.sqlColumn===column)!.fieldId,
    ownerRead:(operation:string,input:unknown={})=>owner("invoke",{revision:1,revisionSha256:revision.revisionSha256,
      operationId:definition.operations.find(value=>value.name===operation)!.operationId,input,idempotencyKey:randomUUID()}),
    async close(){await datasetHost.close();storage.close();rmSync(directory,{recursive:true,force:true,maxRetries:8,retryDelay:25});}};
}
