import { OutboxRecovery } from "../src/conversation/OutboxRecovery";
import { signedInOnly } from "../src/sampleOnly";

// Messages on this phone, from Settings. It needs the signed-in account's outbox.
export default signedInOnly(OutboxRecovery);
