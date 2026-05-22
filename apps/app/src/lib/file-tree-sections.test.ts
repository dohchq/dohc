import { describe, it, expect } from 'vitest'
import {
  isContextPath,
  partitionTree,
  selectQuickAccess,
} from './file-tree-sections'
import type { FileRow } from './path-tree'

const file = (path: string): FileRow => ({ _id: path, path, source: 'user' })
const row = (path: string, extra: Partial<FileRow>): FileRow => ({
  _id: path,
  path,
  source: 'user',
  ...extra,
})

describe('isContextPath — exact reserved membership', () => {
  it('matches the four reserved root atoms', () => {
    for (const p of ['_map.md', 'me.md', 'company.md', 'intent.md']) {
      expect(isContextPath(p)).toBe(true)
    }
  })

  it('matches anything under the skills/ folder', () => {
    expect(isContextPath('skills/email.md')).toBe(true)
    expect(isContextPath('skills/research/deep.md')).toBe(true)
  })

  it('does NOT misclassify look-alike user files', () => {
    // a top-level map.md (no underscore), a user `guides/` folder, a
    // root file literally named `skills.md`, and a reserved name nested
    // under a normal folder must all stay in Personal workspace.
    expect(isContextPath('map.md')).toBe(false)
    expect(isContextPath('guides/foo.md')).toBe(false)
    expect(isContextPath('skills.md')).toBe(false)
    expect(isContextPath('efforts/me.md')).toBe(false)
    expect(isContextPath('me.md.bak')).toBe(false)
  })
})

describe('partitionTree', () => {
  it('routes each file to exactly one section (no duplicates)', () => {
    const files = [
      file('_map.md'),
      file('me.md'),
      file('skills/email.md'),
      file('dashboard.md'),
      file('clients/Acme Corp.md'),
      file('map.md'),
    ]
    const { personalFiles, contextFiles } = partitionTree(files, [])
    expect(contextFiles.map((f) => f.path)).toEqual([
      '_map.md',
      'me.md',
      'skills/email.md',
    ])
    expect(personalFiles.map((f) => f.path)).toEqual([
      'dashboard.md',
      'clients/Acme Corp.md',
      'map.md',
    ])
    // every input file appears once across the two buckets
    expect(personalFiles.length + contextFiles.length).toBe(files.length)
  })

  it('excludes the skills/ folder from Personal folders, keeps the rest', () => {
    const folders = ['skills', 'skills/research', 'clients', 'efforts']
    const { personalFolders } = partitionTree([], folders)
    expect(personalFolders).toEqual(['clients', 'efforts'])
  })

  it('keeps a user folder whose name merely starts with "skills"', () => {
    const { personalFolders } = partitionTree([], ['skillshare'])
    expect(personalFolders).toEqual(['skillshare'])
  })
})

describe('selectQuickAccess', () => {
  it('lists starred first, then recent by updatedAt desc', () => {
    const files = [
      row('clients/Acme.md', { updatedAt: 100 }),
      row('dashboard.md', { starred: true, updatedAt: 50 }),
      row('logs/today.md', { updatedAt: 300 }),
      row('notes/old.md', { updatedAt: 10 }),
    ]
    const items = selectQuickAccess(files)
    expect(items.map((i) => i.path)).toEqual([
      'dashboard.md', // starred (pinned first, regardless of recency)
      'logs/today.md', // 300
      'clients/Acme.md', // 100
      'notes/old.md', // 10
    ])
    expect(items[0].starred).toBe(true)
    expect(items[1].starred).toBe(false)
  })

  it('excludes Context files from recent and never duplicates a starred page', () => {
    const files = [
      row('_map.md', { updatedAt: 999 }), // context — must NOT appear in recent
      row('me.md', { updatedAt: 998 }), // context
      row('skills/email.md', { updatedAt: 997 }), // context (skills/)
      row('dashboard.md', { starred: true, updatedAt: 5 }),
      row('clients/Acme.md', { updatedAt: 200 }),
    ]
    const items = selectQuickAccess(files)
    expect(items.map((i) => i.path)).toEqual([
      'dashboard.md', // starred
      'clients/Acme.md', // only non-context recent
    ])
  })

  it('caps the recent run at recentLimit (starred are not capped)', () => {
    const files = [
      row('a.md', { starred: true, updatedAt: 1 }),
      row('b.md', { starred: true, updatedAt: 2 }),
      ...Array.from({ length: 10 }, (_, i) =>
        row(`r${i}.md`, { updatedAt: 100 + i }),
      ),
    ]
    const items = selectQuickAccess(files, 3)
    const starred = items.filter((i) => i.starred)
    const recent = items.filter((i) => !i.starred)
    expect(starred).toHaveLength(2)
    expect(recent).toHaveLength(3)
    // newest three recents
    expect(recent.map((i) => i.path)).toEqual(['r9.md', 'r8.md', 'r7.md'])
  })
})
