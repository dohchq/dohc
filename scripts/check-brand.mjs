#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const scanner = 'scripts/check-brand.mjs'
const skippedFiles = new Set(['Cargo.lock', 'pnpm-lock.yaml'])
const textExtensions = new Set([
  '.css',
  '.html',
  '.cjs',
  '.cts',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.mts',
  '.ps1',
  '.rs',
  '.sh',
  '.sql',
  '.svg',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
])

const oldProductName = 'vib' + 'eam'
const oldProductWord = 'be' + 'am'
const oldShortName = 'vi' + 'be'
const forbidden = [
  { label: 'old product name', regex: new RegExp(oldProductName, 'i') },
  { label: 'old product word', regex: new RegExp(`\\b${oldProductWord}\\b`, 'i') },
  { label: 'old short name', regex: new RegExp(`\\b${oldShortName}\\b`, 'i') },
]

const violations = []
const trackedFiles = execFileSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean)

for (const path of trackedFiles) {
  if (path === scanner || skippedFiles.has(path)) continue
  const name = basename(path)
  const extension = extname(name).toLowerCase()
  const isEnvironmentExample =
    name.startsWith('.env') && name.endsWith('.example')
  if (!textExtensions.has(extension) && !isEnvironmentExample) continue

  const body = readFileSync(join(root, path))
  if (body.includes(0)) {
    violations.push(`${path}: contains a NUL byte`)
    continue
  }
  const lines = body.toString('utf8').split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    for (const pattern of forbidden) {
      if (pattern.regex.test(lines[index])) {
        violations.push(`${path}:${index + 1}: ${pattern.label}`)
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Brand check failed:')
  for (const violation of violations) console.error(`- ${violation}`)
  process.exit(1)
}

console.log('Brand check passed.')
