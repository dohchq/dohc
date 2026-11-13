# Agent threads and forwarding

Reader: Ice, who agreed the decisions below on November 13, 2026, and the agents who build and review this work.

This plan is proposed. None of it is built.
File references describe `e12aca433`.
Delete this plan when its last release ships.

## The job

A person works with one agent over weeks. The agent runs in a tool built for it, such as a thread in T3 Code or a session in Claude Code or Codex.
The person wants to reach that same agent from dohc, on any device, without copying the agent's whole transcript into a chat.

dohc chat becomes a second way to talk to the agent.
Every message the person sends the agent in dohc reaches the agent thread.
The agent alone decides what it posts back to dohc.

## What exists today

- **An agent dohc starts forgets.** dohc starts Claude Code with `--no-session-persistence` and Codex with `--ephemeral`, once for each message (`agentProfileArguments` in `apps/desktop/src/agents/agentToolCatalog.ts`). The prompt is the whole chat thread (`buildRunnerPrompt` in `apps/desktop/src/agents/chatDispatchService.ts`).
- **A connected agent must ask.** It reads its messages with `dohc chat inbox` and `dohc chat watch`, or with the MCP tool `dohc_wait_for_messages`. Settings shows Listening while it waits (`apps/desktop/src/agents/agentWaits.ts`). dohc never reaches out to it. A message for an agent that is not listening stays unread, and dohc shows no notice.
- **An agent posts with dohc's tools.** `dohc chat reply` and `dohc_reply_to_chat` post a message. `--needs-decision` and `--option` ask the person to choose, and `--resolve` closes an open decision. `--work` and `--link` add a work report.
- **The CLI finds its workspace from the folder it runs in** (`resolveCliWorkspace` in `apps/desktop/src/cli/cliServer.ts`). It has no flag that names a workspace. The Windows app does not put `dohc` on `PATH`.
- **Chat shows when an agent works.** `AgentPresenceHint` in `apps/desktop/src/renderer/workbench/ChatsControls.tsx` draws the dot and "Running codex".
- **A phone message can wake an agent on a computer, behind a switch that is off.** #3857, #3872, #3879, and #3887 built it. Each computer declares the agents dohc can start there. "An agent the person runs on their own is left out" (`apps/desktop/src/chatWakes/chatRunnerDeclaration.ts`).
- **A friend naming your agent wakes nothing.** [ADR 0014](../adr/0014-friends-can-ask-connected-agents-without-confinement.md) plans the Allow flow.

## Decisions

### The model

1. Every agent a person chats with has an **agent thread**, its own continuing conversation in its tool. `CONTEXT.md` defines **Agent thread** and **Forwarding**.
2. dohc forwards the message. It copies nothing back. The agent decides what to post.
3. One agent has one agent thread. A person can point the agent at another agent thread later. The agent's name, color, chats, and History stay.
4. A message is forwarded when it wakes the agent. Today that is the owner's message in the agent's own chat, the owner's mention of the agent, and the owner's later message in a chat thread the agent posted in. Forwarding adds no rule about whose message counts.
5. A chat with an agent remembers. A run that an automation starts still starts fresh, so each automation run stands alone and any computer can run it.

### Tools

6. dohc has built-in support for T3 Code, Claude Code, and Codex. [ADR 0015](../adr/0015-built-in-support-for-agent-tools.md) records why.
7. For T3 Code, the person picks a project, then a thread. dohc uses T3 Code's interface for outside programs, which the person allows once in T3 Code.
8. For Claude Code and Codex, dohc resumes the agent's own session for each message, one message at a time. Adding the agent starts a new session, or the person pastes the id of one they have.
9. For Your command, a switch says the agent keeps its own memory. With it on, dohc gives the command only the new message.
10. dohc reaches every tool through one internal shape, so a later release can replace how it reaches Claude Code or Codex without changing what people see.

### What dohc sends and shows

11. dohc sends the new message, where it came from, and the person's note for that agent. It sends no other chat messages. The agent reads the chat with dohc's tools when it needs more.
12. A person can set one note for each agent. dohc sends it with every message.
13. When the agent is busy, the message waits in line. A setting on each agent forwards it right away as a steer, where the tool can steer. Only T3 Code can.
14. One line for each agent at the foot of the chat shows its state and how long that state has lasted. In a Group, everyone sees the line, but only for work forwarded from that chat. Work the person started in the tool shows only to the owner, in the agent's own chat.
15. When the computer that holds the agent thread is off, dohc holds the message and says so. dohc never starts another agent in its place.
16. When the agent finishes and posts nothing, dohc reminds it once. If it still posts nothing, the chat says so.
17. An edit or a delete after forwarding does not reach the agent.
18. dohc names files and attachments by where they are. The agent opens them.
19. For a T3 Code thread, History marks only the changes the agent makes through dohc's tools. A Claude Code or Codex run keeps today's marking, because dohc starts and ends that run.
20. dohc sets no time limit on a T3 Code thread. A Claude Code or Codex run keeps its time limit.

### Questions

21. The agent asks the person with a dohc decision. When it gets its answer another way, it closes the decision with `--resolve`.
22. When a T3 Code thread waits on its own question box, the chat says the agent is waiting in T3 Code and offers Answer here. dohc shows that question to the owner alone and keeps no copy. The first answer wins, in T3 Code or in dohc.
23. A permission approval stays in the tool. The chat says the agent is waiting for approval and links to the tool.

### Other people

24. Another person's mention of your agent reaches you as a request, under their message and in Notices. You answer Allow or Decline. Until you allow, they see nothing.
25. Allow forwards that one message. A later message from the same person is a new request.
26. The list of people who can ask without your approval lives on the agent's page, in a danger zone. It names a person and applies in every chat you share with them.
27. A link holder can ask. Because their name is unverified, Allow opens a second confirmation. A link holder can never join the list in decision 26.
28. Every agent gets the same warning and no limit. [ADR 0014](../adr/0014-friends-can-ask-connected-agents-without-confinement.md) is amended to match.

### Reach

29. An agent thread serves the workspace it was connected in. The agent's page lists the person's other workspaces, each off until the person turns it on.
30. A T3 Code thread can run on a machine linked in T3 Code. Such a thread needs a synced workspace, because the agent posts back through its personal agent link.
31. From another device, a person can send, read, see states, and answer. Only the desktop that holds the agent thread connects it, changes it, or edits the note.

## How it works

### Kinds of agent thread

| | T3 Code | Claude Code, Codex | Your command |
| --- | --- | --- | --- |
| Who runs the agent | T3 Code | dohc, once for each message | dohc, once for each message |
| Where the agent thread comes from | Picked from T3 Code's projects and threads | New, or a pasted session id | The command's own business |
| While it is busy | Waits in line, or steers | Waits in line | Waits in line |
| How dohc knows its state | Asks T3 Code every few seconds | Owns the process | The program ending ends the work |
| Its own question box | Shown as "waiting in T3 Code", with Answer here | None. A run without a person cannot ask. | None |
| Open in the tool | A `t3code://threads/…` link | A command to copy | None |

### What dohc forwards

A sketch. The first pull request settles the real text.

```text
From Ice in dohc. Workspace "dohc launch", Group "launch", chat thread "Windows build".

can you also check the Mac build?

Files: plans/release.md
Note from Ice: Post decisions and a daily status here. Keep the rest in T3 Code.

Reply in that chat thread: dohc chat reply <chat-thread> --workspace <workspace> --agent-id <agent> "<text>"
Read it first when this message points at something you were not sent: dohc chat show <chat-thread> --workspace <workspace> --peek
```

A message another person sent, and the owner allowed, names both: `From Sam Ortiz (sam@ridge.co) in dohc, allowed by Ice.`

The reply commands carry the full path of dohc's CLI.
`--workspace` is new. The CLI needs a way to name a workspace, because an agent thread works in another folder.

### The introduction

dohc sends it once, when the person connects the agent thread or points the agent at another one. It says:

- Messages from dohc will arrive marked as above.
- Post to dohc only what belongs there. Nothing else you write is shown in dohc.
- Reply in the chat thread a message came from.
- Ask the person with `--needs-decision` and `--option`. Close the decision with `--resolve` when you get the answer another way.
- Read the chat thread when a message points at something you were not sent.
- Report long work with `--work` and `--link`.

### States

The line at the foot of the chat shows one state for each agent, with how long it has lasted. An owner also gets the controls.

| State | Words | Controls for the owner |
| --- | --- | --- |
| The computer is off or unreachable | `Waiting for ICE-PC` | |
| T3 Code is not running there | `Waiting for T3 Code on ICE-PC` | |
| Agents are paused | `Paused` | Resume |
| Forwarded, behind other work | `2 in line` | |
| Working | `Working` | Open in T3 Code |
| Its own question box is open | `Waiting for you in T3 Code` | Open in T3 Code, Answer here |
| A permission approval is open | `Waiting for your approval in T3 Code` | Open in T3 Code |
| Finished, reminded once, posted nothing | `Finished without replying here` | Open in T3 Code |
| dohc is no longer allowed in T3 Code | `dohc can no longer reach T3 Code` | Allow again |
| The thread is gone from T3 Code | `This thread is no longer in T3 Code` | Choose a thread |

Other people in a Group see `Waiting for Ice` where the owner sees a question or an approval.
The line builds on agent presence (`apps/desktop/src/collab/agentPresence.ts`), which carries working and idle today.

dohc shows a message as forwarded only after the tool confirms it took the message.
Each forwarded message has one identity for its whole life, so a lost confirmation cannot forward it twice.

### Silence

When the work that took a message ends and the agent has posted nothing in that chat thread since, dohc forwards one fixed reminder.
dohc records the reminder before it sends it, so a retry cannot remind twice.
If the next work also ends with no post, the line reads `Finished without replying here`.
dohc never posts the agent's words for it.

### Questions the agent asks in its tool

T3 Code holds the only copy of such a question.
dohc learns that a question is open when it asks T3 Code for the thread's state.
Answer here fetches the question, shows it to the owner, and sends the answer to T3 Code.
If T3 Code refuses the answer because someone answered there first, dohc says so and closes the question.

On the owner's other devices, the computer that holds the agent thread passes the question through the server to the owner's signed-in devices.
The server keeps no copy. This needs a path that does not exist yet.

### Other people

A request shows the owner who asks, the message, and the warning.
For a connected agent the warning is ADR 0014's: "<agent> runs outside dohc. dohc can't limit what it does for <person>."
For an agent dohc starts it is: "<agent> runs on this computer as you. dohc can't limit what it does for <person>."

A request does not expire. Decline removes it. The person who asked sees nothing in either case.
Only a person's message can become a request. An agent's post never wakes another person's agent.

Adding a person to the list in decision 26 opens dohc's danger confirmation.
The list shows each person, when they were added, and Remove.

### Settings

An agent's entry in `dohc-settings.json` gains its agent thread, its busy choice, its note, and its workspaces. A sketch:

```json
{
  "chief-of-staff": {
    "name": "Chief of Staff",
    "hue": "plum",
    "enabled": true,
    "thread": { "tool": "t3-code", "environment": "…", "id": "…" },
    "whileBusy": "line",
    "note": "Post decisions and a daily status here. Keep the rest in T3 Code.",
    "workspaces": ["…"]
  }
}
```

`AgentSettings` in `apps/desktop/src/settings/userSettings.ts` allows `enabled` only with `launch` today. An agent with a thread and no launch can also be on.
The sign-in for T3 Code is not in this file. dohc keeps it in the system's credential store on that computer, as `apps/desktop/src/workspaces/cloudCredentialStore.ts` keeps the server sign-in, and never syncs it.

Add agent gains a T3 Code choice under "Runs with", then a project picker, a field to find a thread, and the project's threads.
The agent's page leads with a card for the agent thread's state, Open in T3 Code, and Change thread. Under the note, a preview shows the text the agent receives.

### One shape for every tool

```ts
interface AgentThreadTool {
  can: { steer: boolean; liveState: boolean; questions: boolean; listThreads: boolean };
  forward(message: ForwardedMessage, how: "line" | "steer"): Promise<void>;
  state?(): Promise<AgentThreadState>;
}
```

A sketch. Chat, settings, and the states above depend on this shape and on nothing inside a tool.

### T3 Code

- dohc reads T3 Code's address from `server-runtime.json` in T3 Code's data folder. It does not assume a port.
- dohc signs in to T3 Code's MCP endpoint with the authorization-code flow and PKCE. The person allows dohc in T3 Code once for each computer.
- dohc lists projects and threads, sends a message in line or as a steer, reads a thread's state, and reads and answers its open questions.
- dohc asks for state every few seconds while a forwarded message is in line or in work, and while the agent's own chat is open. It stops when neither is true.
- T3 Code promises no stable interface. dohc checks the tools T3 Code lists when it connects. When a tool it needs is missing, the agent's page says which T3 Code version dohc last worked with.

### Claude Code and Codex

- dohc starts Claude Code with `--session-id <id>` for the first message and `--resume <id>` after it. It starts Codex with `codex exec`, keeps the thread id Codex prints, and uses `codex exec resume <id>` after it.
- An agent runs in the workspace's folder, so it has one session for each workspace it serves.
- While dohc runs a message on a session, that session is dohc's. What happens when the person has the same session open in the tool is not known. Test it before release 2. If two writers damage a session, dohc must detect the tool's own lock and wait.
- The agent's page shows the session id and the command that opens it in the tool.

## Security

- Only the owner's messages are forwarded without a prompt. Every other person's message needs Allow, or a place on the owner's list.
- dohc states the limit it does not have. Interface text must never claim that dohc confines an agent thread.
- A forwarded message can hold text from other people. The agent thread runs with the owner's access. Allow is the safeguard, so the request must show the whole message before the owner answers.
- The T3 Code sign-in can drive every thread the person has. dohc stores it in the system's credential store, sends it only to the address in `server-runtime.json` on this computer, and drops it when the last T3 Code agent is removed.
- dohc runs no command a person did not enter in Settings or choose from the tools dohc found.
- The work that forwards another person's message, and the work that stores the T3 Code sign-in, each need a second independent reviewer for these risks.

## Releases

Each release ships when it is ready. Each needs its own proof on a real tool, not only on a stand-in.

1. **T3 Code on one computer.** The T3 Code tool, Add agent and the agent's page, forwarding with the note, the states, the reminder, Answer here on that computer, `--workspace` in the CLI, and workspaces for an agent. Threads on linked machines for a synced workspace. Its first step is the trial this plan did not run. Forward from a prepared desktop to a scratch T3 Code thread and watch the reply arrive in chat.
2. **Claude Code and Codex.** Sessions resumed for each message, a new session or a pasted id, the switch for Your command, and fresh runs kept for automations. It starts with the two-writers test.
3. **Other devices.** A computer declares the agents whose threads it holds, so a phone message wakes it. Answer here on other devices. This extends the wake work in `apps/desktop/src/chatWakes`. Agree the change with that work's owner first.
4. **Other people.** Requests with Allow and Decline, the list on the agent's page, and the second confirmation for link holders. It depends on release 3.

## Not verified

- Steer, and reading and answering a question, were read in T3 Code's source for `0.1.10-nightly.20261111.4544`. Nobody has run them from outside T3 Code.
- What T3 Code returns when dohc answers a question someone already answered.
- The two-writers case for Claude Code and Codex.
- A linked machine posting back through a personal agent link.

Verified on November 13, 2026: `t3 thread send <thread> - --wait --json` forwarded a message to an idle thread and returned its reply in 9 seconds. A second headless message resumed the first one's session and remembered it, on Claude Code 2.1.322 and codex-cli 0.167.2.

## Not in this plan

- dohc hosting an agent, which means streaming its transcript, answering its approvals, or owning its session. dohc removed that in #1231 and #1334.
- Copying an agent thread into chat.
- A limit on what an agent can reach for another person.
- A picker for existing Claude Code or Codex sessions. Neither tool gives another program a supported list.
- Work cards in the phone app.
