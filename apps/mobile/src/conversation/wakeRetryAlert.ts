import { chatWords } from "@dohc/interface-words/notices";
import type { PhoneChatWake } from "@dohc/workspace-contracts/chat-wakes";
import { confirm } from "../confirm";

/**
 * Before a wake that wasn't confirmed tries another computer: the agent may have started there already. Names the
 * computer and the agent as the line's read does. Resolves true only on Try on another computer.
 */
export const confirmTryElsewhere = (wake: PhoneChatWake): Promise<boolean> =>
  confirm({
    title: chatWords.wakeTryElsewhere,
    message: chatWords.wakeRunTwice(wake.agentName, wake.winnerLabel),
    confirm: chatWords.wakeTryElsewhere,
  });
