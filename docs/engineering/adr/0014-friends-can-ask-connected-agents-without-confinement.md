---
status: accepted
---

# A friend can ask your connected agent, and dohc doesn't confine that request

This records a planned design. None of it is built yet. Today your own messages and your automations can wake your agents, and a friend naming your agent wakes nothing.

In the plan, when someone else asks your agent in a shared chat, nothing runs until you answer Allow, Always allow or Decline. For an agent dohc starts, the plan also limits the run you allow to what the asker can reach. dohc can build that limit only where it controls the agent's tools, settings and credentials. It doesn't fully control them today. A Claude Code run keeps the owner's own Claude Code settings for actions outside the workspace, and a custom command runs with no launch profile. dohc can never control them for a connected agent, such as an always-on cloud orchestrator, which has its own tools and its own sign-in.

We still let a friend ask a connected agent through the same Allow, Always allow and Decline answers, because asking each other's agents is the core of the shared-work loop. Allow passes the friend's message to the agent and says plainly: "<agent> runs outside dohc. dohc can't limit what it does for <person>." Always allow is offered only after the owner has seen that warning for that agent.

## Amended November 13, 2026

Ice changed four parts of this plan while agreeing [agent threads and forwarding](../plans/agent-threads-and-forwarding.md). Where this section and the text above disagree, this section holds.

- **A request starts in one way.** Another person's message mentions the agent or replies under its message. dohc forwards no other message of theirs, for a listed person either. Allow controls forwarding only: an agent that reads the chat with dohc's tools sees every message its owner can see.
- **The request offers Allow and Decline only.** Always allow moves to the agent's page, in a danger zone that lists the people who can ask without approval. An entry is one server account, never a name or an email. It applies in every chat the owner shares with that person, in every workspace the agent serves. Adding a person opens a danger confirmation.
- **Allow covers one revision of one message.** The request shows the exact text dohc will pass on. An edit or a delete before the owner answers cancels the request. A later message from the same person is a new request.
- **An agent dohc starts gets the warning, not a limit.** The plan above limited such a run to what the asker can reach. dohc cannot build that limit, so it must not offer it. The request names the computer: "<agent> runs on <computer> as you. dohc can't limit what it does for <person>."
- **A link holder can ask.** Their name is unverified, so Allow opens a second confirmation that says so, and the agent is told the sender is an unverified link holder. A link holder can never be added to the list.

The server fixes who sent a message, and only the owner's signed-in account can answer a request. The person who asks sees nothing until the owner allows. A request does not expire.

## Considered options

- **Only the owner can ask a connected agent.** Honest and simple, but friends can't ask each other's agents directly, which is the scenario this work starts from.
- **Give the request a token limited to the friend's reach.** Rejected. The agent can still use its own sign-in, so the limit would look real without being real. AGENTS.md rules out bluffing about isolation.

## Consequences

- dohc may promise that a run reaches only what the asker can reach only for a run whose tools, settings and credentials dohc controls, and only once that limit is built. Interface copy and docs must never claim it for a connected agent.
- If dohc later gets a way to confine a connected agent, such as a per-request link it can verify the agent uses exclusively, revisit this decision.
