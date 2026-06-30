#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = [
  'docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.md',
  'docs/superpowers/plans/2026-06-23-think-bigger-dohc-workspace-engine.execution-log.md',
  'docs/superpowers/specs/2026-06-22-dohc-versioned-workspace-design.md',
  'docs/superpowers/specs/2026-06-23-dohc-native-filesystem-design.md',
  'docs/superpowers/specs/2026-06-23-dohc-chats-design.md',
]

const visibleHeadingText = (heading) => heading
  .replace(/!\[([^\]\n]*)\]\([^)]*\)/g, '$1')
  .replace(/\[([^\]\n]+)\]\([^)]*\)/g, '$1')
  .replace(/\[([^\]\n]+)\]\[[^\]\n]*\]/g, '$1')
  .replace(/`([^`]*)`/g, '$1')
  .replace(/<[^>]+>/g, '')

const slug = (heading) => visibleHeadingText(heading)
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9\s-]/g, '')
  .replace(/\s+/g, '-')

function* contentLines(markdown) {
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

    if (!inFence) {
      yield line
    }
  }
}

const collectAnchors = (markdown) => {
  const anchors = new Set()
  const seen = new Map()

  for (const line of contentLines(markdown)) {
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

  for (const line of contentLines(markdown)) {
    for (const match of line.matchAll(linkPattern)) {
      links.push(match[1])
    }
  }

  return links
}

const failures = []
const anchorCache = new Map()

const anchorsFor = (targetPath) => {
  let anchors = anchorCache.get(targetPath)
  if (!anchors) {
    anchors = collectAnchors(fs.readFileSync(targetPath, 'utf8'))
    anchorCache.set(targetPath, anchors)
  }
  return anchors
}

for (const file of files) {
  const filePath = path.resolve(repoRoot, file)

  if (!fs.existsSync(filePath)) {
    failures.push(`missing source file ${file}`)
    continue
  }

  const text = fs.readFileSync(filePath, 'utf8')
  anchorCache.set(filePath, collectAnchors(text))
  for (const raw of collectLinks(text)) {
    if (/^(https?:|mailto:|app:)/.test(raw)) {
      continue
    }

    const hashIndex = raw.indexOf('#')
    const targetRaw = hashIndex === -1 ? raw : raw.slice(0, hashIndex)
    const anchorRaw = hashIndex === -1 ? '' : raw.slice(hashIndex + 1)
    let decodedTarget
    let decodedAnchor
    try {
      decodedTarget = targetRaw === '' ? '' : decodeURIComponent(targetRaw)
      decodedAnchor = anchorRaw === '' ? '' : decodeURIComponent(anchorRaw)
    } catch {
      failures.push(`${file}: invalid link target ${raw}`)
      continue
    }

    const targetPath = path.normalize(
      decodedTarget === ''
        ? path.resolve(filePath)
        : path.resolve(path.dirname(filePath), decodedTarget),
    )
    const relativeTarget = path.relative(repoRoot, targetPath)
    if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
      failures.push(`${file}: link target escapes repository root ${raw}`)
      continue
    }

    let targetStat
    try {
      targetStat = fs.statSync(targetPath)
    } catch {
      failures.push(`${file}: missing link target ${raw}`)
      continue
    }

    if (!targetStat.isFile()) {
      failures.push(`${file}: link target is not a file ${raw}`)
      continue
    }

    if (!decodedAnchor) {
      continue
    }

    if (!anchorsFor(targetPath).has(slug(decodedAnchor))) {
      failures.push(`${file}: missing anchor ${raw}`)
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}

console.log(`docs link/anchor check passed for ${files.length} files`)
