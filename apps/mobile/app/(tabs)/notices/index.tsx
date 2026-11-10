import { ServerNotices } from "../../../src/notices/ServerNotices";

// Notices: the sample's in a sample build, the server's otherwise.
export default __DEV__ || process.env.EXPO_PUBLIC_DOHC_SAMPLE === "1" ? (require("../../../src/notices/SampleNotices") as typeof import("../../../src/notices/SampleNotices")).SampleNotices : ServerNotices;
