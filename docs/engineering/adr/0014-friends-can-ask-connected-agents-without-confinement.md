---
status: accepted
---

# A friend can ask your connected agent, and dohc doesn't confine that request

This records a planned design. None of it is built yet. Today your own messages and your automations can wake your agents, and a friend naming your agent wakes nothing.

In the plan, when someone else asks your agent in a shared chat, nothing runs until you answer Allow, Always allow or Decline. For an agent dohc starts, the plan also limits the run you allow to what the asker can reach. dohc can build that limit only where it controls the agent's tools, settings and credentials. It doesn't fully control them today. A Claude Code run keeps the owner's own Claude Code settings for actions outside the workspace, and a custom command runs with no launch profile. dohc can never control them for a connected agent, such as an always-on cloud orchestrator, which has its own tools and its own sign-in.

We still let a friend ask a connected agent through the same Allow, Always allow and Decline answers, because asking each other's agents is the core of the shared-work loop. Allow passes the friend's message to the agent and says plainly: "<agent> runs outside dohc. dohc can't limit what it does for <person>." Always allow is offered only after the owner has seen that warning for that agent.

## Considered options

- **Only the owner can ask a connected agent.** Honest and simple, but friends can't ask each other's agents directly, which is the scenario this work starts from.
- **Give the request a token limited to the friend's reach.** Rejected. The agent can still use its own sign-in, so the limit would look real without being real. AGENTS.md rules out bluffing about isolation.

## Consequences

- dohc may promise that a run reaches only what the asker can reach only for a run whose tools, settings and credentials dohc controls, and only once that limit is built. Interface copy and docs must never claim it for a connected agent.
- If dohc later gets a way to confine a connected agent, such as a per-request link it can verify the agent uses exclusively, revisit this decision.
