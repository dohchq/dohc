import { ServerConversation } from "../../src/conversation/ServerConversation";

// A chat or a thread: the sample's in a sample build, the server's otherwise.
export default __DEV__ || process.env.EXPO_PUBLIC_DOHC_SAMPLE === "1" ? (require("../../src/conversation/SampleConversation") as typeof import("../../src/conversation/SampleConversation")).SampleConversation : ServerConversation;
