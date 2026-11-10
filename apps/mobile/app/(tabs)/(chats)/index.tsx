import { ServerChats } from "../../../src/chats/ServerChats";

// Chats: the sample's in a sample build, the server's otherwise.
export default __DEV__ || process.env.EXPO_PUBLIC_DOHC_SAMPLE === "1" ? (require("../../../src/chats/SampleChats") as typeof import("../../../src/chats/SampleChats")).SampleChats : ServerChats;
