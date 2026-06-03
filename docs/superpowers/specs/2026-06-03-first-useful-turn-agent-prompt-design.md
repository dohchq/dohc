# First Useful Turn Agent Prompt Design

Date: 2026-06-03

## Decision

dohc will tune the agent prompt around a first-useful-turn contract for vague
workspace-building requests. The agent should behave like a skilled
Notion/Obsidian workspace designer: diagnose the user's problem, choose the
right dohc medium, then build source-backed structure only after it has enough
context to avoid generic scaffolding.

For vague requests such as "help me with my training routine", the first useful
turn is not artifact creation. The first useful turn is diagnosis: learn the
goal, current state, constraints, failure history, and the feedback loop the
workspace should improve.

## Problem

The current prompt already says "source first, view second" and contains a
tracking/improvement section, but the runtime behavior can still produce vague
blank pages, decorative dashboards, and arbitrary views. That leaves the user
wondering what to do next.

The failure is not only phrasing. The agent lacks a crisp first-turn operating
contract for vague asks:

- when to pause and ask intake questions
- how many questions are enough
- how to decide between markdown atoms, html atoms, custom `.views`, entities,
  skills, and commands
- what "useful" means before files exist
- what tests should catch generic workspace slop

## Research Basis

Current model guidance points away from large clever prompts and toward clear
outcomes, success criteria, tool contracts, and evals:

- OpenAI GPT-5.5 guidance recommends outcome-first prompts with expected
  outcome, success criteria, allowed side effects, evidence rules, and output
  shape. It also recommends starting with the smallest prompt that preserves the
  product contract, then tuning reasoning effort, tool descriptions, verbosity,
  and output format against examples.
  Source: https://developers.openai.com/api/docs/guides/latest-model
- OpenAI reasoning guidance warns that "think step by step" style instructions
  can be unnecessary or harmful for reasoning models. It recommends direct
  prompts, delimiters, specific constraints, and success criteria.
  Source: https://developers.openai.com/api/docs/guides/reasoning-best-practices
- OpenAI eval guidance recommends an evaluation flywheel: annotate failures,
  group recurring failure modes, create graders/tests, and iterate from data
  instead of "prompt-and-pray".
  Source:
  https://developers.openai.com/cookbook/examples/evaluation/building_resilient_prompts_using_an_evaluation_flywheel
- Anthropic's agent guidance emphasizes simple composable agent patterns,
  strong tool design, clear checkpoints, and grounding agent loops in
  environment feedback.
  Source: https://www.anthropic.com/engineering/building-effective-agents
- Google Gemini function-calling guidance highlights clear tool descriptions,
  specific parameters, tool selection discipline, clarification when needed, and
  validation before consequential actions.
  Source: https://ai.google.dev/gemini-api/docs/function-calling

## Goals

- Make vague "help me with X" requests feel like the start of a custom
  workspace design session, not a template dump.
- Prevent the agent from creating dashboards or views before it understands the
  user's source data and feedback loop.
- Teach the agent to choose the right dohc medium for the problem.
- Make first-turn output useful even before files exist.
- Keep the prompt compact enough that it is maintainable and model-portable.
- Add prompt-contract tests that catch generic pages, fake metrics, arbitrary
  views, and missing intake.

## Non-Goals

- No full prompt rewrite in this design. The implementation should be a focused
  prompt patch plus tests.
- No new dohc primitives.
- No hardcoded domain templates for every possible workflow.
- No medical, fitness, finance, or legal expert system. The agent can structure
  the user's workspace, but should not pretend to be a credentialed specialist.
- No background/scheduled automation.

## First Useful Turn Protocol

When the user makes a vague workspace-building request, the agent should:

1. Call `onboarding_state` first, as the existing prompt requires.
2. If maintenance mode, inspect relevant existing atoms/entities before asking
   if the request names a recognizable area.
3. Classify the job the workspace needs to do. Examples: routine, tracker,
   project cockpit, knowledge base, habit loop, decision system, CRM-like
   workflow, review cadence, report, dashboard, or interactive operating
   surface.
4. Ask 3-5 compact, domain-specific questions before creating files, unless the
   user's prompt already answered enough of them.
5. Explain what it will build and why once the answers are sufficient.
6. Build source atoms/entities first, then optional presentation/interface files.
7. Hand back the next action the user can do today.

This is a stopping rule: if the agent cannot answer what source data, workflow
loop, and next user decision the files support, it should not create a
dashboard, html atom, or custom view yet.

## Intake Question Shape

The agent should ask enough to avoid slop, but not run a giant interview. A good
first intake has 3-5 questions and covers:

- Desired outcome: what success looks like.
- Current baseline: where the user is now.
- Constraints: time, tools, schedule, access, injuries, budget, team, or other
  limits relevant to the domain.
- Failure history: what has not worked or what keeps slipping.
- Feedback loop: what the workspace should help decide, remember, review, or
  surface.

Questions should be concrete and domain-shaped. For a training routine, ask
about goal, current routine, schedule, equipment/constraints, and what usually
breaks down. For a client workflow, ask about pipeline stages, source of truth,
recurring handoffs, review cadence, and what decisions are currently messy.

The agent should not ask questions whose answers would not change the structure
it builds.

## Medium Selection

The agent should choose the medium from the problem, not arbitrarily.

| Need | Preferred medium | Why |
| --- | --- | --- |
| Source of truth, notes, plans, logs, templates, routines, reviews | Markdown atom (`.md`) | Editable, inspectable, and durable. This is the default canonical work state. |
| Repeated records such as people, clients, projects, exercises, habits, leads | Entities, often with markdown source atoms | Better querying and flexible record structure when the data repeats. |
| Polished read-only report, dashboard, one-pager, or briefing over source data | HTML atom (`.html`) | Good when the user needs a composed presentation view, not interaction. |
| Interactive workflow surface, kanban, form-like cockpit, buttons/actions, filters, repeat-use app | Folder-local `.views/<name>/` app | Use when interaction or app-like behavior matters. |
| Reusable process the user liked and wants to repeat | Skill | Captures an agent workflow/playbook the user owns. |
| Explicit shortcut fired from slash/palette | Command | Captures a user-triggered shortcut, not a background process. |

Hard rules:

- Markdown source comes before interfaces.
- HTML and `.views` are views over source state, never the canonical source.
- Do not create a view just because the user asked for "help".
- If no workflow loop exists yet, start with markdown atoms and intake.
- If the user explicitly asks for a "view", use `.views/<name>/`, but still
  create or improve source atoms first.
- If the user asks for a dashboard but there is no real data yet, ask intake
  questions and propose the source model before making the dashboard.

## Artifact Expectations After Intake

After the user answers intake questions, the agent should build a small coherent
system, not a pile of pages. A useful build usually includes:

- a goal/profile atom that captures outcome, baseline, constraints, cadence, and
  operating preferences
- one or more source atoms for the actual work state
- a log or review template if progress or repetition matters
- a review cadence atom when the system needs periodic adjustment
- entities only when repeated records need flexible querying
- an html atom or `.views` app only when it has real source data to read and a
  clear user-facing job
- a run note explaining what was created, where truth lives, what is missing,
  and what the user should do next

The agent should keep first builds modest. The point is not to impress with file
count. The point is to make the user's next real action obvious.

## Example: Training Routine

User says: "help me with my training routine"

Bad first turn:

- creates `training.md`, `dashboard.html`, and a generic view
- invents a weekly plan
- shows fake progress numbers
- leaves no clear logging or review loop

Good first turn:

- inspects existing training/health/routine files if present
- says it can build a training operating system, but needs a few specifics
- asks 3-5 questions:
  - What are you training for and what outcome would make this worth it?
  - What is your current baseline or current routine?
  - How many days/minutes per week can you realistically train?
  - Any equipment limits, injuries, or recovery constraints?
  - What usually makes routines fail for you?
- after answers, proposes the source structure:
  - `training/profile.md`
  - `training/routine.md`
  - `training/sessions/template.md`
  - `training/reviews/weekly-template.md`
  - optional `training/dashboard.html` only if read-only progress overview is
    useful
  - optional `training/.views/cockpit/` only if the user wants an interactive
    daily cockpit

The final handoff should say what to do next today, such as "log today's
baseline session in `training/sessions/...`" or "answer the missing equipment
constraint before I shape the plan."

## Prompt Architecture

The implementation should add a concise section near the top of `SYSTEM_PROMPT`,
after the current dohc system map and before domain-specific tracking guidance.

Suggested section:

- `## FIRST USEFUL TURN FOR VAGUE WORKSPACE REQUESTS`
- Defines vague requests.
- States that diagnosis is the first useful turn.
- Gives the 3-5 question intake rule.
- Gives the source/workflow/next-decision stopping rule.
- Gives the medium-selection matrix or compact equivalent.

The existing `TRACKING / IMPROVEMENT PROJECTS` section should be updated to fit
this contract, not duplicate it. It should point to the first-useful-turn rules
and add domain examples for coaching loops.

The prompt should avoid hidden chain-of-thought instructions. Use phrases like
"evaluate", "classify", and "choose" rather than requiring the model to expose
reasoning.

## Tool Guidance

No new tool is required for this pass.

The prompt should steer tool use lightly:

- `list_atoms` and `read_atom` are appropriate before intake when existing
  context may already answer questions.
- `create_atom`, `create_entities`, `insert_after_heading`, and view creation
  happen after the agent has enough context.
- `save_skill` and `save_command` remain opt-in after a useful repeated process,
  not part of the first-turn default.

Future work may add a first-class "workspace design plan" tool or structured
intake state, but the MVP should validate the prompt behavior first.

## Testing

Add or update system prompt tests in `apps/app/convex/a1SystemPrompt.test.ts`.

Required assertions:

- prompt contains `FIRST USEFUL TURN` or equivalent section
- vague "help me with X" requests are treated as diagnosis-first
- agent asks 3-5 domain-specific questions before creating files when context is
  insufficient
- prompt says not to create dashboards/views before source data and workflow
  loop are known
- prompt includes md/html/.views/entities/skills/commands medium-selection rules
- prompt says markdown source is the canonical default and interfaces come after
  source
- tracking/improvement guidance still includes baseline, target outcome,
  constraints, session log template, review cadence, recurring mistakes, and
  next focus

Optional eval fixture:

- Input: "help me with my training routine"
- Passing behavior: asks intake questions and does not create files.
- Failing behavior: creates generic training pages, fake progress, or a
  decorative dashboard.

## Risks

- Asking too many questions can make dohc feel like a normal chatbot. Keep the
  intake to questions that change the workspace shape.
- Overly rigid medium rules could block useful creativity. The matrix should be
  a default decision model, not a total prohibition.
- The prompt may still be too large. If the section grows, prefer examples and
  tests over more prose.
- Some users will expect immediate artifacts. The handoff should make diagnosis
  feel valuable by naming the custom system the agent is preparing to build.

## Open Later

- A structured intake/result schema for workspace design turns.
- Offline eval harness for first-turn prompt behavior.
- Domain-specific reusable skills for training, CRM, research, writing, finance,
  and operations workflows.
- A UI affordance that shows the proposed source/view structure before the agent
  writes files.
