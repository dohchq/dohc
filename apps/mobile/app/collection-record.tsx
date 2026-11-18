import { RecordScreen } from "../src/collections/CollectionScreens";
import { signedInOnly } from "../src/sampleOnly";

// One record of the Collection on screen, read-only.
export default signedInOnly(RecordScreen);
