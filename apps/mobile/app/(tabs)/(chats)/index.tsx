import { ServerChats } from "../../../src/chats/ServerChats";

// Chats: the sample's in a sample build, the server's otherwise.
// src/routes.test.ts reads the next statement as text, on one line.
// oxfmt-ignore
export default __DEV__ || process.env.EXPO_PUBLIC_DOHC_SAMPLE === "1" ? (require("../../../src/chats/SampleChats") as typeof import("../../../src/chats/SampleChats")).SampleChats : ServerChats;
