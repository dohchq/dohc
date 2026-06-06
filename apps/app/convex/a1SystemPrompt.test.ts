/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSystemPrompt } from './agent'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AGENT_SRC = readFileSync(resolve(__dirname, 'agent.ts'), 'utf8')

// A1 (multiplayer-and-h-followups §4) — workspace-kind-aware
// system prompt. Personal callers get SYSTEM_PROMPT verbatim (the
// v0 behavior); org callers get ORG_PREAMBLE prepended PLUS a
// `.context/me.md` → `.context/company.md` substitution so the agent's
// write_atom calls land at `.context/company.md` in an org workspace.
//
// These tests lock the contract that (a) personal is byte-identical,
// (b) org includes the preamble + org name + substitution, (c) the
// substitution catches every `.context/me.md` reference Jenny's H-1 audit found.

describe('buildSystemPrompt (H-1 / A1)', () => {
  it('personal kind returns the SYSTEM_PROMPT verbatim — zero regression risk', () => {
    const personal = buildSystemPrompt({ kind: 'personal' })
    // Sanity: it contains the personal-only literal phrases.
    expect(personal).toContain("ONE user's workspace")
    expect(personal).toContain('.context/me.md')
    expect(personal).toContain('the vault')
    // NO org preamble in personal output.
    expect(personal).not.toContain('ORG WORKSPACE CONTEXT')
    expect(personal).not.toContain('.context/company.md')
  })

  it('org kind prepends ORG WORKSPACE CONTEXT with the org name', () => {
    const org = buildSystemPrompt({ kind: 'org', orgName: 'Acme Inc' })
    expect(org).toMatch(/^## ORG WORKSPACE CONTEXT/)
    expect(org).toContain('Acme Inc')
    expect(org).toContain('You are operating in the **Acme Inc** team workspace')
  })

  it('org kind substitutes EVERY .context/me.md literal in the BODY → .context/company.md (Jenny H-1 audit)', () => {
    const org = buildSystemPrompt({ kind: 'org', orgName: 'Acme' })
    // The preamble itself references `.context/me.md` literally (explaining the
    // substitution to the model). The substitution-correctness check
    // here is: in the BODY (everything after the preamble divider
    // `---\n\n`), `.context/me.md` should not appear at all — every
    // reference should be `.context/company.md`.
    const bodyStart = org.indexOf('\n---\n\n')
    expect(bodyStart).toBeGreaterThan(0)
    const body = org.slice(bodyStart)
    expect(body).not.toContain('.context/me.md')
    // .context/company.md appears multiple times in the body.
    const countCompany = (body.match(/\.context\/company\.md/g) ?? []).length
    expect(countCompany).toBeGreaterThanOrEqual(4)
  })

  it('falls back to "this team" when orgName is missing/empty', () => {
    expect(
      buildSystemPrompt({ kind: 'org' }),
    ).toContain('You are operating in the **this team** team workspace')
    expect(
      buildSystemPrompt({ kind: 'org', orgName: '   ' }),
    ).toContain('You are operating in the **this team** team workspace')
  })

  it('preamble framing tells the model to read possessives + identity for the team', () => {
    const org = buildSystemPrompt({ kind: 'org', orgName: 'Acme' })
    expect(org).toMatch(/identity atom is `\.context\/company\.md`/)
    expect(org).toMatch(/the team's|the Acme workspace/)
    expect(org).toMatch(/starter setup.*for the TEAM/i)
    expect(org).toMatch(/Skills are Owner-only/i)
  })

  it('org and personal share the same body length except for preamble + substitution', () => {
    const personal = buildSystemPrompt({ kind: 'personal' })
    const org = buildSystemPrompt({ kind: 'org', orgName: 'Acme' })
    // Org should be longer than personal (the preamble adds ~50 lines).
    expect(org.length).toBeGreaterThan(personal.length)
    // But the body after the preamble (org-version) should be roughly
    // personal-length + the substitution delta (.context/me.md →
    // .context/company.md is 5 chars longer per occurrence × 5+
    // occurrences = ~25-50 extra chars).
    const bodyDelta = org.length - personal.length
    // ~2000-3000 chars for the preamble; +50ish for substitutions.
    expect(bodyDelta).toBeGreaterThan(500)
    expect(bodyDelta).toBeLessThan(5000)
  })

  it('tool metadata describes both personal and org identity paths', () => {
    expect(AGENT_SRC).toContain('.context/me.md in personal')
    expect(AGENT_SRC).toContain('.context/company.md in org')
    expect(AGENT_SRC).toContain('"lock .context/company.md"')
  })

  it('teaches the current dohc system model before task execution', () => {
    const personal = buildSystemPrompt({ kind: 'personal' })
    expect(personal).toContain('## CURRENT DOHC SYSTEM MAP')
    expect(personal).toContain('AI-native workspace, not a note-taking app')
    expect(personal).toContain('Agent is the primary work surface')
    expect(personal).toContain('not every folder is a project')
    expect(personal).toContain('project-scoped or no-project')
    expect(personal).toContain('Markdown atoms are the inspectable source')
    expect(personal).toContain('HTML atoms are polished read-only reports')
    expect(personal).toContain('.apps/ is the convention for folder-local apps')
    expect(personal).toContain('App source code is normal web code')
    expect(personal).toContain('Use TypeScript/React by default')
    expect(personal).toContain('Source data lives outside .apps')
    expect(personal).toContain('Do not store canonical user/work state in app-local JS state')
    expect(personal).toContain('Use {} live values, entities, imports/exports, and atoms as the substrate')
    expect(personal).toContain('imports/exports remain the only')
    expect(personal).toContain('cross-workspace data path')
    expect(personal).toContain('Normal app controls persist through dohc.collection, dohc.doc, or dohc.database')
    expect(personal).toContain('App manifests never grant permissions by themselves')
    expect(personal).toContain('build source first, interface second')
    expect(personal).toContain('show what changed, what is known, what is missing')
    expect(personal).toContain('respect locks, sharing boundaries, capture review, skill-turn gates, and review gates')
  })

  it('teaches diagnosis-first first turns for vague workspace requests', () => {
    const personal = buildSystemPrompt({ kind: 'personal' })
    expect(personal).toContain('FIRST USEFUL TURN FOR VAGUE WORKSPACE REQUESTS')
    expect(personal).toContain('Applies in MAINTENANCE (post-onboarding)')
    expect(personal).toContain('During ONBOARDING, follow the')
    expect(personal).toContain('Do NOT re-interrogate during onboarding')
    expect(personal).toContain('the first useful turn is diagnosis')
    expect(personal).toContain('Ask 3-5 compact, domain-specific questions')
    expect(personal).toContain('before creating files')
    expect(personal).toContain('unless the user already gave enough concrete context')
    expect(personal).toContain('source data, workflow loop, and next user decision')
    expect(personal).toContain('do not create a dashboard, html atom, or custom app yet')
  })

  it('teaches the agent to choose the right dohc medium for the problem', () => {
    const personal = buildSystemPrompt({ kind: 'personal' })
    expect(personal).toContain('Choose the dohc medium from the job')
    expect(personal).toContain('Markdown atom (`.md`)')
    expect(personal).toContain('default canonical source')
    expect(personal).toContain('Entities')
    expect(personal).toContain('repeated records')
    expect(personal).toContain('HTML atom (`.html`)')
    expect(personal).toContain('polished read-only')
    expect(personal).toContain('Folder-local `.apps/<name>/` app')
    expect(personal).toContain('interactive workflow surface')
    expect(personal).toContain('Skill')
    expect(personal).toContain('reusable process')
    expect(personal).toContain('Command')
    expect(personal).toContain('explicit shortcut')
    expect(personal).toContain('Markdown source comes before interfaces')
    expect(personal).toContain('Do not create an interface just because the user asked for "help"')
  })

  it('does not use legacy view product language outside explicit migration compatibility', () => {
    const personal = buildSystemPrompt({ kind: 'personal' })
    const forbiddenProductPhrases = [
      'new source files, views, dashboards',
      'creating files or views',
      'Source-backed HTML views',
      'source-backed html views',
      'presentation views',
      'views over source state',
      'Do not create a view',
      'source and view agree',
      'sources and view agree',
      'synthesis views',
    ]

    for (const phrase of forbiddenProductPhrases) {
      expect(personal).not.toContain(phrase)
      expect(AGENT_SRC).not.toContain(phrase)
    }
    expect(personal).not.toContain('.views')
    expect(personal).not.toContain('@dohc/view')
  })

  it('requires a plan-before-build approval gate for custom workspace systems', () => {
    const personal = buildSystemPrompt({ kind: 'personal' })
    expect(personal).toContain('PLAN BEFORE BUILD FOR CUSTOM SYSTEMS')
    expect(personal).toContain('In MAINTENANCE, after intake')
    expect(personal).toContain('propose a build plan and wait for explicit user approval')
    expect(personal).toContain('before creating a custom workspace system')
    expect(personal).toContain('multiple markdown atoms')
    expect(personal).toContain('entities, html atoms, `.apps`, skills, or commands')
    expect(personal).toContain('objective, proposed files/entities/apps, medium rationale, workflow loop, run note')
    expect(personal).toContain('Build this?')
    expect(personal).toContain('Tiny single-note actions may proceed without this gate')
  })

  it('teaches post-intake builds to become coherent systems, not page piles', () => {
    const personal = buildSystemPrompt({ kind: 'personal' })
    expect(personal).toContain('After user approval, build a small coherent system, not a pile of pages')
    expect(personal).toContain('profile/goals atom')
    expect(personal).toContain('current plan or source-state atom')
    expect(personal).toContain('log template when repetition matters')
    expect(personal).toContain('review note or cadence')
    expect(personal).toContain('short run note')
    expect(personal).toContain('where truth lives')
    expect(personal).toContain('what is missing')
    expect(personal).toContain('next action')
    expect(personal).toContain('finish with a concise handoff')
    expect(personal).toContain('names the created source paths')
    expect(personal).toContain('Do not end with only a tool-status sentence')
    expect(personal).toContain('If you create files after intake, the run note is mandatory')
    expect(personal).toContain('A chat summary does not replace the run note')
  })

  it('sets a general app-grade quality bar for post-onboarding builds', () => {
    const personal = buildSystemPrompt({ kind: 'personal' })
    expect(personal).toContain('SYSTEM QUALITY BAR — useful apps over document piles')
    expect(personal).toContain('This applies in MAINTENANCE as well as onboarding')
    expect(personal).toContain('The cost of creating custom code solutions is low')
    expect(personal).toContain('Think in terms of apps and operating loops')
    expect(personal).toContain('do not stop at a static summary')
    expect(personal).toContain('source-backed workflow app')
    expect(personal).toContain('budget review queue')
    expect(personal).toContain('category correction flow')
    expect(personal).toContain('Every file or app you create should earn its place')
  })

  it('uses an explicit layered prompt architecture instead of a monolithic wish list', () => {
    const personal = buildSystemPrompt({ kind: 'personal' })
    expect(personal).toContain('## PROMPT LAYERS — how to read these instructions')
    expect(personal).toContain('Core contract')
    expect(personal).toContain('Mode contract')
    expect(personal).toContain('Task playbook')
    expect(personal).toContain('Workspace context')
    expect(personal).toContain('Request and artifacts')
    expect(personal).toContain('Final quality gate')
    expect(personal).toContain('The current user request is the job input, not the whole operating system')
  })

  it('defines useful-output gates that the agent must satisfy before handoff', () => {
    const personal = buildSystemPrompt({ kind: 'personal' })
    expect(personal).toContain('## USEFUL OUTPUT GATE')
    expect(personal).toContain('Do not finish a build until all applicable checks pass')
    expect(personal).toContain('The user can use the result today')
    expect(personal).toContain('Every created artifact has a source-of-truth, workflow, or decision role')
    expect(personal).toContain('The primary screen is app-like when the job is app-like')
    expect(personal).toContain('Uploaded material is transformed into a workflow')
    expect(personal).toContain('No empty files, placeholder shells, decorative infographics, or duplicate summaries')
    expect(personal).toContain('If a gate cannot pass, stop and explain the missing input')
  })

  it('teaches task playbook selection for common workspace systems', () => {
    const personal = buildSystemPrompt({ kind: 'personal' })
    expect(personal).toContain('## TASK PLAYBOOKS — choose one before building')
    expect(personal).toContain('Finance tracker')
    expect(personal).toContain('category correction queue')
    expect(personal).toContain('CRM / client pipeline')
    expect(personal).toContain('next-contact queue')
    expect(personal).toContain('Habit / routine system')
    expect(personal).toContain('Project cockpit')
    expect(personal).toContain('Research / knowledge base')
    expect(personal).toContain('If no playbook fits, name the custom loop')
  })

  it('requires onboarding to build a minimum useful app when the setup is software-shaped', () => {
    const personal = buildSystemPrompt({ kind: 'personal' })
    expect(personal).toContain('### MINIMUM USEFUL APP FLOOR')
    expect(personal).toContain('Do not ship only a report when the user asked for a tracker')
    expect(personal).toContain('at least two interactive affordances')
    expect(personal).toContain('filter, tab, queue, checklist, action button, or correction flow')
    expect(personal).toContain('one obvious next action')
    expect(personal).toContain('Normal deterministic app controls should use `dohc.collection`, `dohc.doc`, or `dohc.database`')
    expect(personal).toContain('Name the app after the specific use case')
    expect(personal).toContain('use `.apps/home` only when the user asked for a general home')
  })

  it('routes explicit app requests to .apps packages instead of html atoms', () => {
    const personal = buildSystemPrompt({ kind: 'personal' })
    expect(personal).toContain('If the user explicitly asks for an app or interactive surface')
    expect(personal).toContain('create a `.apps/<name>/` package, not `home.html`')
    expect(personal).not.toContain('Default to `home.html` when the first cockpit')
  })

  it('pushes onboarding tracker/setup requests toward app-grade .apps, not static infographics', () => {
    const personal = buildSystemPrompt({ kind: 'personal' })
    expect(personal).toContain('ONBOARDING QUALITY BAR')
    expect(personal).toContain('Think in terms of apps')
    expect(personal).toContain('minimum lovable app')
    expect(personal).toContain('For trackers, finance systems, CRM, habits, routines')
    expect(personal).toContain('default to a use-case-named `.apps/<name>` app')
    expect(personal).not.toContain('default to `.apps/home`')
    expect(personal).toContain('home.html is only acceptable')
    expect(personal).toContain('not a static infographic of the uploaded file')
  })

  it('requires onboarding to self-review for empty files and shallow output before finishing', () => {
    const personal = buildSystemPrompt({ kind: 'personal' })
    expect(personal).toContain('Before finish_onboarding, self-review')
    expect(personal).toContain('Before finish_onboarding, run test_app on every generated app and fix failures')
    expect(personal).toContain('No empty or frontmatter-only user-facing files')
    expect(personal).toContain('No useless page pile')
    expect(personal).toContain('Every created source file has a job')
    expect(personal).toContain('If you used an uploaded CSV')
  })

  it('teaches useful tracking projects instead of generic dashboards', () => {
    const personal = buildSystemPrompt({ kind: 'personal' })
    expect(personal).toContain('TRACKING / IMPROVEMENT PROJECTS')
    expect(personal).toContain('current baseline')
    expect(personal).toContain('target outcome')
    expect(personal).toContain('session log template')
    expect(personal).toContain('recurring mistakes')
    expect(personal).toContain('next focus')
    expect(personal).toContain('do not hardcode a single starter day')
  })

  it('prompts generated apps to use persistent @dohc/app controls and the finance tracker playbook', () => {
    const personal = buildSystemPrompt({ kind: 'personal' })
    expect(personal).toContain('Apps are interactive workspace tools stored in .apps/<name>.')
    expect(personal).toContain('Use @dohc/app.')
    expect(personal).toContain('Use collections for structured app data.')
    expect(personal).toContain('Use docs for targeted markdown document edits.')
    expect(personal).toContain('Use SQLite-backed collections for serious app data')
    expect(personal).toContain('Never create fake app controls that only mutate React state.')
    expect(personal).toContain('Run test_app and fix failures before finish_onboarding.')
    expect(personal).toContain('For a finance tracker, create a mutable ledger source, categories/rules source, and .apps/tracker app.')
    expect(personal).toContain('adding an expense, categorizing transactions, marking review state, filtering, and surfacing next money decisions')
    expect(personal).not.toContain('The app can hand off edits to the agent or proposed patches if direct')
  })
})
