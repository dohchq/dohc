---
status: accepted
---

# dohc forwards a message to the agent's own thread and copies nothing back

This records a planned design. None of it is built yet. Today an agent dohc starts keeps nothing between messages, and a connected agent must ask dohc for its messages. dohc never reaches out to an agent that runs elsewhere, and a message for an agent that is not listening stays unread with no notice.

In the plan, every agent a person chats with has an agent thread, its own continuing conversation in its tool. When a person's message wakes the agent, dohc forwards that message to the agent thread. dohc sends the new message, where it came from, and the person's note for that agent. It sends no other chat messages, and the agent reads the chat with dohc's tools when it needs more. A command the person runs as an agent gets only the new message when the person says the agent keeps its own memory. Otherwise it gets the chat's recent messages, as it does today. The agent alone decides what it posts back. dohc never posts the agent's words for it.

An agent thread works in a folder of its own, and the CLI finds its workspace from the folder it runs in today. So a forwarded message names its workspace by an id no other person can set, and the instructions it carries for reading the chat and replying use that id. A workspace's name never selects a workspace, because other people can change it.

A person works with one agent for weeks in a tool built for that. We chose forwarding so dohc chat is a second way to reach the same agent, on any device, without dohc becoming the place the agent runs.

The rest of the design follows from that choice.

- In a workspace, an agent has one agent thread. A person can point the agent at another one later, and the agent's name, color, chats, and History stay.
- An agent serves the workspace it was connected in. The person turns on each other workspace. A thread a tool hosts, such as a T3 Code thread, can serve several workspaces as one agent thread. A Claude Code or Codex agent gets a separate agent thread in each workspace.
- A message is forwarded under the conditions that reach that kind of agent today, no more and no fewer. Its owner wrote it in dohc, not through the CLI or MCP. For an agent dohc starts, it is in the agent's own chat, mentions the agent, replies under its message, or is in a post or Comment the agent started. For an agent dohc does not start, it is in the agent's own chat, mentions the agent, or is any later message in a chat thread the agent posted in. ADR 0014 adds the messages from other people that the owner allows.
- A chat with an agent remembers. A run that an automation starts still starts fresh, so each automation run stands alone and any computer can run it.
- When the agent is busy, the message waits in line. A setting on each agent forwards the owner's message right away as a steer, where the tool can steer. Another person's message always waits in line.
- One line for each agent at the foot of the chat shows its state and how long that state has lasted. In a Group, everyone sees it, but only for work forwarded from that chat. Work the person started in the tool shows only to the owner, in the agent's own chat. Other people never see the name of the owner's computer.
- When the computer that holds the agent thread is off, dohc holds the message and says so. dohc never starts another agent in its place.
- When the agent finishes and posts nothing, dohc reminds it once. If it still posts nothing, the chat says so.
- An edit or a delete after forwarding does not reach the agent.
- The agent asks the person with a dohc decision. When a tool's own question box is open, the chat says the agent is waiting there. dohc can show that question to the owner alone and pass the answer back, and it keeps no copy. A permission approval stays in the tool.

[ADR 0015](0015-built-in-support-for-agent-tools.md) records which tools dohc knows. [ADR 0014](0014-friends-can-ask-connected-agents-without-confinement.md) records how another person asks someone's agent.

## Considered options

- **Copy the agent thread into chat.** Every message and every reply would appear in both places. Rejected. A long-lived agent thread can hold tens of thousands of items, dohc would have to read each tool's transcript, and two copies would have to stay equal through queued messages and interruptions.
- **Keep the agent asking for its messages.** This is what a connected agent does today. Rejected as the only way. An agent thread between turns is not listening, so the message waits until something else wakes it.
- **dohc hosts the agent.** dohc would run the agent, stream its transcript, and answer its approvals. Rejected. dohc removed that role in #1231 and #1334, because dohc does not provide or supervise people's agents.
- **Start a fresh agent when the agent thread cannot be reached.** Rejected. A different agent with none of the agent thread's memory would answer under the same name.

## Consequences

- dohc cannot confine an agent thread. Interface copy and docs must never claim that it does.
- The engine or the relay fixes who wrote a message. dohc never takes the author from a name a client sends. No post made through the CLI or MCP is forwarded, so an agent cannot wake an agent, itself included.
- Other people can set a workspace's or a Group's name, a chat thread's title, a file's or an attachment's name, and a display name. Each such value reaches the agent as an escaped, quoted string on one line. Only dohc writes the other lines, so no such value can pass for a line dohc adds, such as the owner's note.
- An allowed message from another person names its sender and says the owner allowed it. For a link holder it says the sender is unverified. dohc quotes that person's text line by line, so no line of it can pass for a line dohc adds.
- Only the desktop that holds the agent thread connects it, changes it, or edits the note. dohc runs no command a person did not enter in Settings or choose from the tools dohc found.
- Each forwarded message has one identity for its whole life, so a lost confirmation cannot forward it twice. dohc shows a message as forwarded only after the tool confirms it took the message. dohc records the reminder before it sends it.
- A sign-in that lets dohc drive a tool's threads can reach every thread the person has there. dohc sends it only to the address on this computer where the tool issued it, at `127.0.0.1` or `::1`, and signs in again when the tool moves to another address. dohc encrypts it with the system's credential encryption, keeps no plain copy, never syncs it, and does not connect when the system cannot encrypt. dohc drops it when the tool refuses it and when the last agent that needs it is removed. dohc acts only on the threads its agents are connected to.
- dohc cannot tell which program answers at an address. Another program running as the same person can take the tool's address, or ask the system to decrypt the kept sign-in. Interface copy and docs must not claim that dohc stops this.
- One agent thread that serves two workspaces holds both workspaces' messages. Content from one can appear in the other's chats, including to other people there. Turning on a second workspace says so before it takes effect.
- Reaching an agent thread from another device needs its own kind of wake. The wake path in `apps/desktop/src/chatWakes` starts a run on whichever computer claims it. A forwarded message must go to the one computer that holds the agent thread and must never start a run on any other computer. Passing a tool's question to the owner's other devices needs its own route. On it the relay chooses the owner's devices, accepts an answer only from them, and neither stores nor logs the question or the answer.
- A thread on a machine linked in a tool cannot reach the owner's dohc. It posts back through a personal agent link, so it needs a synced workspace. That link is a credential held in the agent thread's transcript. Its reach is that agent and the workspaces it serves, a post made with it is never forwarded, removing the agent revokes it, and pointing the agent at another thread revokes it and issues a new one.
