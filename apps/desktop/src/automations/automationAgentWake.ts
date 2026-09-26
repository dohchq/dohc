import type { AutomationChatMessage } from "./automationChat";

// A personal step that wakes its person's agent (item 6, section 4). The
// dispatch scan wakes the agent only for a person's own messages, so an
// automation's text that says "@agent" wakes nobody. This step posts the
// automation's message into "My agent", in one thread per automation, then
// queues that message as the agent's trigger. The run's per-thread budget,
// 10 runs in 10 minutes, bounds how often it can wake.

export const AUTOMATION_NO_RUNNER =
  "No agent runner is set up. Set one up in Settings → Agents & MCP, then try again.";

// The engine's answer when a key was already used for another request: the
// thread's first message went out under this effect's key before a stop.
const KEY_ALREADY_USED = "idempotency-key-reuse-mismatch";

export interface AgentWakeDependencies {
  /** Whether this computer has an agent runner set up. */
  runnerReady(): Promise<boolean>;
  /** The "My agent" channel's id, made when it does not exist yet. */
  agentChannelId(): Promise<string>;
  threadExists(threadId: string): Promise<boolean>;
  /** Starts the thread with its first message. */
  start(input: { channelId: string; message: AutomationChatMessage }): Promise<unknown>;
  /** Adds the message to the thread. */
  send(input: { message: AutomationChatMessage }): Promise<unknown>;
  /** Queues the message as the agent's trigger; a message is queued once. */
  recordTrigger(input: { triggerMessageId: string; threadId: string }): unknown;
  /** Asks the dispatch to run what is queued. */
  scan(): void;
}

/** Posts the automation's message to its person's agent and queues the wake. */
export async function wakeAgent(dependencies: AgentWakeDependencies, message: AutomationChatMessage): Promise<void> {
  if (!(await dependencies.runnerReady())) throw new Error(AUTOMATION_NO_RUNNER);
  if (await dependencies.threadExists(message.threadId)) {
    try {
      await dependencies.send({ message });
    } catch (error) {
      if (!(error instanceof Error && error.message === KEY_ALREADY_USED)) throw error;
    }
  } else {
    await dependencies.start({ channelId: await dependencies.agentChannelId(), message });
  }
  await dependencies.recordTrigger({ triggerMessageId: message.messageId, threadId: message.threadId });
  dependencies.scan();
}
