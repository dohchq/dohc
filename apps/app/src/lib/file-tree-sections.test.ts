import { describe, it, expect } from 'vitest'
import {
  isContextPath,
  partitionTree,
} from './file-tree-sections'
import type { FileRow } from './path-tree'

const file = (path: string): FileRow => ({ _id: path, path, source: 'user' })

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
