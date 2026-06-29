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

const collectAnchors = (markdown) => {
  const anchors = new Set()
  const seen = new Map()
  let inFence = false
  let fenceChar = null

  for (const line of markdown.split(/\r?\n/)) {
    const fence = line.match(/^\s{0,3}(```+|~~~+)/)

    if (fence) {
      const marker = fence[1][0]
      if (!inFence) {
        inFence = true
        fenceChar = marker
      } else if (marker === fenceChar) {
        inFence = false
        fenceChar = null
      }
      continue
    }

    if (inFence) {
      continue
    }

    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)
    if (!heading) {
      continue
    }

    const base = slug(heading[1])
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    anchors.add(count === 0 ? base : `${base}-${count}`)
  }

  return anchors
}

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
    const anchors = collectAnchors(targetText)

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
