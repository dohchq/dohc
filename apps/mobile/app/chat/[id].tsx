import { ServerConversation } from "../../src/conversation/ServerConversation";

// A chat or a thread: the sample's in a sample build, the server's otherwise.
// src/routes.test.ts reads the next statement as text, on one line.
// oxfmt-ignore
export default __DEV__ || process.env.EXPO_PUBLIC_DOHC_SAMPLE === "1" ? (require("../../src/conversation/SampleConversation") as typeof import("../../src/conversation/SampleConversation")).SampleConversation : ServerConversation;
