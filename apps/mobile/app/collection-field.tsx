import { FieldEditorScreen } from "../src/collections/FieldEditor";
import { signedInOnly } from "../src/sampleOnly";

// One field of the open record, changed in a sheet. Without phone writes it shows nothing to change.
export default signedInOnly(FieldEditorScreen);
