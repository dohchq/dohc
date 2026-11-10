import { ServerPage } from "../src/pages/ServerPage";

// A page: the sample's in a sample build, the server's otherwise.
export default __DEV__ || process.env.EXPO_PUBLIC_DOHC_SAMPLE === "1" ? (require("../src/pages/SamplePage") as typeof import("../src/pages/SamplePage")).SamplePage : ServerPage;
