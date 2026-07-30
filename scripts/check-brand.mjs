#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const scanner = 'scripts/check-brand.mjs'
const skippedDirectories = new Set([
  '.git',
  '.next',
  '.output',
  '.turbo',
  '.vercel',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'target',
  'test-results',
])
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
for (const file of walk(root)) {
  const path = normalize(relative(root, file))
  if (path === scanner || skippedFiles.has(path)) continue
  const body = readFileSync(file)
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

function* walk(directory) {
  for (const name of readdirSync(directory)) {
    if (skippedDirectories.has(name) || name.startsWith('target-')) continue
    const path = join(directory, name)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      yield* walk(path)
      continue
    }
    const extension = extname(name).toLowerCase()
    if (
      stat.isFile() &&
      (textExtensions.has(extension) || name.startsWith('.env'))
    ) {
      yield path
    }
  }
}

function normalize(path) {
  return path.replace(/\\/g, '/')
}
