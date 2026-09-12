import { openSyncRelayStorage } from "../storage";
import type { AcceptAppCollectionInput } from "../storage/appCollections";

// A second SQLite connection in another process exercises the real writer lock.
const storage = openSyncRelayStorage(process.argv[2]);
process.send?.({kind:"ready"});
process.once("message", (input:AcceptAppCollectionInput) => {
  try { process.send?.({kind:"accepted",receipt:storage.acceptAppCollection(input,{maxCreatesPerGrant:2})}); }
  catch(error) { process.send?.({kind:"refused",message:error instanceof Error?error.message:String(error)}); }
  finally {storage.close();process.disconnect?.();}
});
