import { CollectionScreen } from "../src/collections/CollectionScreens";
import { signedInOnly } from "../src/sampleOnly";

// A transactional Collection's records, from Home. It needs the signed-in account's open workspace.
export default signedInOnly(CollectionScreen);
