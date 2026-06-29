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
  let fenceLength = 0

  for (const line of markdown.split(/\r?\n/)) {
    const fence = line.match(/^\s{0,3}(```+|~~~+)/)

    if (fence) {
      const marker = fence[1][0]
      const markerLength = fence[1].length
      if (!inFence) {
        inFence = true
        fenceChar = marker
        fenceLength = markerLength
      } else if (marker === fenceChar && markerLength >= fenceLength) {
        inFence = false
        fenceChar = null
        fenceLength = 0
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

const collectLinks = (markdown) => {
  const links = []
  const linkPattern = /!?\[[^\]\n]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  let inFence = false
  let fenceChar = null
  let fenceLength = 0

  for (const line of markdown.split(/\r?\n/)) {
    const fence = line.match(/^\s{0,3}(```+|~~~+)/)

    if (fence) {
      const marker = fence[1][0]
      const markerLength = fence[1].length
      if (!inFence) {
        inFence = true
        fenceChar = marker
        fenceLength = markerLength
      } else if (marker === fenceChar && markerLength >= fenceLength) {
        inFence = false
        fenceChar = null
        fenceLength = 0
      }
      continue
    }

    if (inFence) {
      continue
    }

    for (const match of line.matchAll(linkPattern)) {
      links.push(match[1])
    }
  }

  return links
}

const failures = []

for (const file of files) {
  if (!fs.existsSync(file)) {
    failures.push(`missing source file ${file}`)
    continue
  }

  const text = fs.readFileSync(file, 'utf8')
  for (const raw of collectLinks(text)) {
    if (/^(https?:|mailto:|app:)/.test(raw)) {
      continue
    }

    const hashIndex = raw.indexOf('#')
    const targetRaw = hashIndex === -1 ? raw : raw.slice(0, hashIndex)
    const anchorRaw = hashIndex === -1 ? '' : raw.slice(hashIndex + 1)
    let decodedTarget
    try {
      decodedTarget = targetRaw === '' ? '' : decodeURIComponent(targetRaw)
    } catch {
      failures.push(`${file}: invalid link target ${raw}`)
      continue
    }

    const targetPath = path.normalize(
      decodedTarget === ''
        ? path.resolve(file)
        : path.resolve(path.dirname(file), decodedTarget),
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
