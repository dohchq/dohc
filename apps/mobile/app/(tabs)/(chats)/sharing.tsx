import { sampleOnly } from "../../../src/sampleOnly";

// src/routes.test.ts reads the next statement as text, on one line.
// oxfmt-ignore
export default sampleOnly(__DEV__ || process.env.EXPO_PUBLIC_DOHC_SAMPLE === "1" ? (require("../../../src/sharing/SampleSharing") as typeof import("../../../src/sharing/SampleSharing")).SampleSharing : null);
