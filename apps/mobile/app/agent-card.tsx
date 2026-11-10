import { sampleOnly } from "../src/sampleOnly";

export default sampleOnly(__DEV__ || process.env.EXPO_PUBLIC_DOHC_SAMPLE === "1" ? (require("../src/chats/SampleAgentCard") as typeof import("../src/chats/SampleAgentCard")).SampleAgentCard : null);
