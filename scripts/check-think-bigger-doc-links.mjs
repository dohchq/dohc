#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

const files = [
  'docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.md',
  'docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.execution-log.md',
  'docs/superpowers/specs/2026-06-22-dohc-versioned-workspace-design.md',
  'docs/superpowers/specs/2026-06-23-dohc-native-filesystem-design.md',
  'docs/superpowers/specs/2026-06-23-dohc-chats-design.md',
]

const slug = (heading) => heading
  .trim()
  .toLowerCase()
  .replace(/`([^`]*)`/g, '$1')
  .replace(/<[^>]+>/g, '')
  .replace(/[^a-z0-9\s-]/g, '')
  .replace(/\s+/g, '-')
  .replace(/-+/g, '-')

const failures = []

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  const linkPattern = /!?\[[^\]\n]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

  for (const match of text.matchAll(linkPattern)) {
    const raw = match[1]

    if (/^(https?:|mailto:|app:|#)/.test(raw)) {
      continue
    }

    const [targetRaw, anchorRaw] = raw.split('#')
    const targetPath = path.normalize(
      path.resolve(path.dirname(file), decodeURIComponent(targetRaw || file)),
    )

    if (!fs.existsSync(targetPath)) {
      failures.push(`${file}: missing link target ${raw}`)
      continue
    }

    if (!anchorRaw) {
      continue
    }

    const targetText = fs.readFileSync(targetPath, 'utf8')
    const anchors = new Set(
      [...targetText.matchAll(/^#{1,6}\s+(.+)$/gm)].map((heading) => slug(heading[1])),
    )

    if (!anchors.has(anchorRaw.toLowerCase())) {
      failures.push(`${file}: missing anchor ${raw}`)
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}

console.log(`docs link/anchor check passed for ${files.length} files`)
