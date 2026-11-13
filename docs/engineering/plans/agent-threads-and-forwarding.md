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

- **An agent dohc starts forgets.** dohc starts Claude Code with `--no-session-persistence` and Codex with `--ephemeral`, once for each message (`agentProfileArguments` in `apps/desktop/src/agents/agentToolCatalog.ts`). The prompt holds the chat thread's recent messages, cut to a size budget, and names the command that reads the rest (`apps/desktop/src/agents/runnerThreadContext.ts`).
- **A message wakes an agent under four conditions.** Its owner wrote it in dohc, not through the CLI or MCP. And it is in the agent's own chat, or mentions the agent, or replies under the agent's message, or is in a post or Comment the agent started (`answeredAgentIdOf` in `apps/desktop/src/workspaces/chatWrites.ts`). A Group's running conversation has no starter, so there only a mention or a reply under the agent's message wakes it.
- **A connected agent must ask.** It reads its messages with `dohc chat inbox` and `dohc chat watch`, or with the MCP tool `dohc_wait_for_messages`. Settings shows Listening while it waits (`apps/desktop/src/agents/agentWaits.ts`). dohc never reaches out to it. A message for an agent that is not listening stays unread, and dohc shows no notice.
- **An agent posts with dohc's tools.** `dohc chat reply` and `dohc_reply_to_chat` post a message. `--needs-decision` and `--option` ask the person to choose, and `--resolve` closes an open decision. `--work` and `--link` add a work report.
- **An agent that signed in with a personal agent link can post less.** Its `dohc_post_channel` takes the message text, where to post it, and an idempotency key (`chatPostFields` in `services/share-web/src/remoteMcp.ts`). It has no field for a decision or a work report, so the agent cannot ask for a decision, close one, or report work.
- **The CLI finds its workspace from the folder it runs in** (`resolveCliWorkspace` in `apps/desktop/src/cli/cliServer.ts`). It has no flag that names a workspace. The Windows app does not put `dohc` on `PATH`.
- **Chat shows when an agent works.** `AgentPresenceHint` in `apps/desktop/src/renderer/workbench/ChatsControls.tsx` draws the dot and "Running codex".
- **A phone message can wake an agent on a computer, behind a switch that is off** (`CHAT_WAKES_ON` in `apps/desktop/src/chatWakes/chatWakeLifetime.ts`). #3857, #3872, #3879, #3887, and #3893 built it. Each computer declares the agents dohc can start there. "An agent the person runs on their own is left out" (`apps/desktop/src/chatWakes/chatRunnerDeclaration.ts`).
- **A friend naming your agent wakes nothing.** [ADR 0014](../adr/0014-friends-can-ask-connected-agents-without-confinement.md) plans the Allow flow.

## Decisions

### The model

1. Every agent a person chats with has an **agent thread**, its own continuing conversation in its tool. `CONTEXT.md` defines **Agent thread** and **Forwarding**.
2. dohc forwards the message. It copies nothing back. The agent decides what to post.
3. In a workspace, an agent has one agent thread. A person can point the agent at another agent thread later. The agent's name, color, chats, and History stay.
4. A message is forwarded when it wakes the agent, under the four conditions above. Forwarding adds no condition and removes none. The engine or the relay fixes who wrote a message. dohc never takes the author from a name a client sends. No agent's post is forwarded to any agent, the owner's own included.
5. A chat with an agent remembers. A run that an automation starts still starts fresh, so each automation run stands alone and any computer can run it.

### Tools

6. dohc has built-in support for T3 Code, Claude Code, and Codex. [ADR 0015](../adr/0015-built-in-support-for-agent-tools.md) records why.
7. For T3 Code, the person picks a project, then a thread. dohc uses T3 Code's interface for outside programs, which the person allows once in T3 Code.
8. For Claude Code and Codex, dohc resumes the agent thread for each message, one message at a time. Adding the agent starts a new agent thread, or the person pastes the id of a session they have.
9. For Your command, a switch says the agent keeps its own memory. With it on, dohc gives the command only the new message.
10. dohc reaches every tool through one internal shape, so a later release can replace how it reaches Claude Code or Codex without changing what people see.

### What dohc sends and shows

11. dohc sends the new message, where it came from, and the person's note for that agent. It sends no other chat messages. The agent reads the chat with dohc's tools when it needs more.
12. A person can set one note for each agent. dohc sends it with every message.
13. When the agent is busy, the message waits in line. A setting on each agent forwards the owner's message right away as a steer, where the tool can steer. Only T3 Code can. Another person's message always waits in line.
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

24. Another person's message that mentions your agent, or replies under its message, reaches you as a request, under their message and in Notices. You answer Allow or Decline. Until you allow, they see nothing. No other message of theirs reaches the agent.
25. A request is for one revision of one message. Allow forwards that revision. A later message from the same person is a new request.
26. The list of people who can ask without your approval lives on the agent's page, in a danger zone. An entry is one server account. A listed person's message that would make a request is forwarded without one. The entry applies in every chat you share with that person, in every workspace the agent serves.
27. A link holder can ask. Because their name is unverified, Allow opens a second confirmation. A link holder can never join the list in decision 26.
28. Every agent gets the same warning and no limit. [ADR 0014](../adr/0014-friends-can-ask-connected-agents-without-confinement.md) is amended to match.

### Reach

29. An agent serves the workspace it was connected in. The agent's page lists the person's other workspaces, each off until the person turns it on. A T3 Code thread can serve several workspaces as one agent thread. A Claude Code or Codex agent gets a separate agent thread in each workspace.
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

The reply commands carry the full path of dohc's CLI.
`--workspace` is new. The CLI needs a way to name a workspace, because an agent thread works in another folder.

A message from another person, which the owner allowed, differs in two ways.
Its first line names both people: `From Sam Ortiz (sam@ridge.co) in dohc, allowed by Ice.`
For a link holder it reads `From an unverified link holder who gave the name "Sam", allowed by Ice.`
dohc quotes the other person's text line by line, so no line of it can pass for a line dohc adds, such as `Note from Ice:`.

The same holds for every message, the owner's included. Other people can set a Group's name, a chat thread's title, a file's or an attachment's name, and their own display name. dohc puts each such value on one line as an escaped, quoted string, so it cannot start a new line or pass for a line dohc adds.

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

Other people in a Group see `Waiting for Ice` in place of the first two rows, the question, and the approval. They never see the name of the owner's computer.
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

On the owner's other devices, the computer that holds the agent thread passes the question through the server.
The relay sends it only to devices signed in to the owner's account, and accepts an answer only from them. The relay decides which devices those are. It takes no device list from the desktop.
The server neither stores nor logs the question or the answer, and a test must prove that. This path does not exist yet.

### Other people

A request shows the owner who asks and the exact text dohc will forward, with its file and attachment names, and the warning.
An edit or a delete before the owner answers cancels the request. An edit makes a new request for the new revision.
dohc forwards the revision the owner allowed, never a later one.

The server fixes who sent the message.
The computer that holds the agent thread accepts Allow or Decline only from the owner's signed-in account, and the answer names the revision.

For a connected agent the warning is ADR 0014's: "<agent> runs outside dohc. dohc can't limit what it does for <person>."
For an agent dohc starts it names the computer: "<agent> runs on <computer> as you. dohc can't limit what it does for <person>."

A request does not expire. Decline removes it. The person who asked sees nothing in either case.
Only a message a person wrote can become a request. An agent's post never does.

Adding a person to the list in decision 26 opens dohc's danger confirmation. A sketch:

```text
Let Sam ask Chief of Staff without your approval?
When Sam mentions Chief of Staff or replies to it, in any chat you share, the message reaches it with your access and without asking you. dohc can't limit what it does for Sam.
[Cancel] [Always allow Sam]
```

The list shows each person, when they were added, and Remove.

### Workspaces

Turning on another workspace for a T3 Code agent opens a confirmation.
It says that one agent thread will hold both workspaces' messages, so content from one can appear in the other's chats, including to other people there.
A Claude Code or Codex agent needs no such confirmation, because each workspace has its own agent thread.

Turning on a workspace for any agent whose list in decision 26 has people opens a confirmation, whatever the tool. It names each listed person who will be able to ask the agent in that workspace.

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

- dohc reads T3 Code's address from `server-runtime.json` in T3 Code's data folder. It does not assume a port. It connects only when that address is `127.0.0.1` or `::1`, and refuses any other, a host name included.
- dohc signs in to T3 Code's MCP endpoint with the authorization-code flow and PKCE. The person allows dohc in T3 Code once for each computer.
- dohc encrypts the sign-in with the system's credential encryption and never syncs it. `apps/desktop/src/workspaces/cloudCredentialStore.ts` does the same for the server sign-in when that encryption is available, and keeps a plain copy when it is not. dohc keeps no plain copy of the T3 Code sign-in. When the system cannot encrypt, dohc does not connect T3 Code and says why.
- dohc drops the sign-in when T3 Code refuses it and when the last T3 Code agent is removed.
- The sign-in can reach every thread the person has. dohc lists projects and threads only while the person picks one, and after that acts only on threads its agents are connected to.
- dohc sends a message in line or as a steer, reads a thread's state, and reads and answers its open questions.
- dohc asks for state every few seconds while a forwarded message is in line or in work, and while the agent's own chat is open. It stops when neither is true.
- dohc reaches a thread on a linked machine through T3 Code on this computer, with the same sign-in.
- T3 Code promises no stable interface. dohc checks the tools T3 Code lists when it connects. When a tool it needs is missing, the agent's page says which T3 Code version dohc last worked with.

### Claude Code and Codex

- dohc starts Claude Code with `--session-id <id>` for the first message and `--resume <id>` after it. It starts Codex with `codex exec`, keeps the thread id Codex prints, and uses `codex exec resume <id>` after it.
- dohc runs the agent in the workspace's folder, so each workspace it serves has its own agent thread.
- While dohc runs a message on an agent thread, that agent thread is dohc's. What happens when the person has it open in the tool at that moment is not known. Test it before release 3. If two writers damage it, dohc must detect the tool's own lock and wait.
- The agent's page shows the session id and the command that opens it in the tool.

## Security

- A message reaches an agent thread only when its owner wrote it in dohc, or when the owner allowed that revision, or when its sender is on the owner's list and it mentions the agent or replies under its message. The engine or the relay fixes each of those identities.
- Every value another person can set reaches the agent as an escaped, quoted string on one line. Only dohc writes the other lines.
- No post made through the CLI or MCP is forwarded, so an agent cannot wake an agent, itself included.
- dohc states the limit it does not have. Interface text must never claim that dohc confines an agent thread.
- A forwarded message can hold text from other people. The agent thread runs with the owner's access. Allow is the safeguard, so the request shows the exact text and dohc forwards exactly that.
- The T3 Code sign-in can drive every thread the person has. The T3 Code section above says where dohc keeps it, where dohc sends it, and when dohc drops it.
- dohc runs no command a person did not enter in Settings or choose from the tools dohc found.
- The work that forwards another person's message, the work that stores the T3 Code sign-in, and the work that lets a phone message wake an agent thread each need a second independent reviewer for these risks.

## Releases

Each release ships when it is ready. Each needs its own proof on a real tool, not only on a stand-in.

1. **T3 Code on one computer.** The T3 Code tool, Add agent and the agent's page, forwarding with the note, the states, the reminder, Answer here on that computer, `--workspace` in the CLI, and workspaces for an agent. Its first step is the trial this plan did not run. Forward from a prepared desktop to a scratch T3 Code thread and watch the reply arrive in chat.
2. **T3 Code threads on linked machines.** The introduction for such a thread gives the agent its personal agent link. dohc ties the identity that link signs in to the agent in Settings. `dohc_post_channel` gains decisions, closing a decision, and work reports. The link is a credential that sits in the agent thread's transcript, so four rules hold. Its reach is that agent and the workspaces it serves. A post made with it is never forwarded. Remove on the agent's page revokes it. Pointing the agent at another thread, or turning off a workspace, replaces it.
3. **Claude Code and Codex.** Agent threads resumed for each message, a new one or a pasted session id, the switch for Your command, and fresh runs kept for automations. It starts with the two-writers test.
4. **Other devices.** A computer declares the agents whose threads it holds, so a phone message wakes it. Answer here on other devices. This changes who can be named as a wake target in `apps/desktop/src/chatWakes`, which is an authorization change to a contract the phone app work owns. Agree it with that work first.
5. **Other people.** Requests with Allow and Decline, the list on the agent's page, and the second confirmation for link holders. It depends on release 4.

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
