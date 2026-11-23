import { RecordScreen } from "../src/collections/CollectionScreens";
import { signedInOnly } from "../src/sampleOnly";

// One record of the Collection on screen. With phone writes on, its fields open their editors.
export default signedInOnly(RecordScreen);
