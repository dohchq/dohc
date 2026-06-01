import * as esbuild from 'esbuild'
import { builtinModules, createRequire } from 'node:module'
import { dirname, extname, join, normalize, relative } from 'node:path'
import { VIRTUAL_DOHC_SDK } from './virtualDohcSdk'

type ViewSourceFile = {
  relativePath: string
  body: string
}

type Diagnostic = {
  code: string
  message: string
}

export type BuildViewBundleResult =
  | { ok: true; code: string; diagnostics: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[] }

export const MAX_VIEW_SOURCE_FILES = 100
export const MAX_VIEW_SOURCE_BYTES = 512 * 1024
export const MAX_VIEW_BUNDLE_BYTES = 1024 * 1024
const TEXT_ENCODER = new TextEncoder()
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
])
const require = createRequire(import.meta.url)

function bytes(value: string): number {
  return TEXT_ENCODER.encode(value).length
}

function diagnostic(code: string, message: string): BuildViewBundleResult {
  return { ok: false, diagnostics: [{ code, message }] }
}

function cleanRelativePath(path: string): string | null {
  const clean = normalize(path.replace(/^\/+/, '')).replace(/\\/g, '/')
  if (!clean || clean === '.' || clean.startsWith('../') || clean.includes('/../')) {
    return null
  }
  return clean
}

function loaderFor(path: string): esbuild.Loader {
  const ext = extname(path).toLowerCase()
  if (ext === '.tsx') return 'tsx'
  if (ext === '.ts') return 'ts'
  if (ext === '.jsx') return 'jsx'
  if (ext === '.js') return 'js'
  if (ext === '.json') return 'json'
  return 'text'
}

function jsString(value: string): string {
  return JSON.stringify(value)
}

function resolveRelativeImport(
  files: Map<string, string>,
  importer: string,
  specifier: string,
): string | null {
  const base = cleanRelativePath(join(dirname(importer), specifier))
  if (!base) return null
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.json`,
    `${base}.css`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/index.jsx`,
  ]
  return candidates.find((candidate) => files.has(candidate)) ?? null
}

export async function buildViewBundle({
  entry,
  files,
}: {
  entry: string
  files: ViewSourceFile[]
}): Promise<BuildViewBundleResult> {
  if (files.length > MAX_VIEW_SOURCE_FILES) {
    return diagnostic(
      'too-many-files',
      'This view has too many source files to render safely.',
    )
  }

  let totalBytes = 0
  const fileMap = new Map<string, string>()
  for (const file of files) {
    const cleanPath = cleanRelativePath(file.relativePath)
    if (!cleanPath) return diagnostic('invalid-path', 'A view source path is invalid.')
    totalBytes += bytes(file.body)
    if (totalBytes > MAX_VIEW_SOURCE_BYTES) {
      return diagnostic(
        'source-too-large',
        'This view source is too large to render safely.',
      )
    }
    fileMap.set(cleanPath, file.body)
  }

  const cleanEntry = cleanRelativePath(entry)
  if (!cleanEntry || !fileMap.has(cleanEntry)) {
    return diagnostic('missing-entry', 'The view entry file was not found.')
  }

  const plugin: esbuild.Plugin = {
    name: 'dohc-view-virtual-files',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const fromView = args.namespace === 'dohc-view' || args.importer === ''
        if (args.path === 'react' || args.path === 'react-dom/client') {
          return { path: require.resolve(args.path) }
        }
        if (!fromView && args.path !== '@dohc/view') return undefined
        if (args.kind === 'dynamic-import') {
          return {
            errors: [{ text: 'dynamic-import' }],
          }
        }
        if (/^https?:\/\//i.test(args.path)) {
          return {
            errors: [{ text: 'remote-import' }],
          }
        }
        if (args.path.startsWith('/')) {
          return {
            errors: [{ text: 'absolute-import' }],
          }
        }
        if (args.path === '@dohc/view') {
          return { path: args.path, namespace: 'dohc-view-sdk' }
        }
        if (args.path === cleanEntry && args.importer === '') {
          return { path: cleanEntry, namespace: 'dohc-view' }
        }
        if (args.path.startsWith('.')) {
          const importer = args.importer.replace(/^\/+/, '')
          const resolved = resolveRelativeImport(fileMap, importer, args.path)
          if (!resolved) return { errors: [{ text: 'missing-relative-import' }] }
          return { path: resolved, namespace: 'dohc-view' }
        }
        if (NODE_BUILTINS.has(args.path)) {
          return { errors: [{ text: 'unsupported-import' }] }
        }
        return { errors: [{ text: 'unsupported-import' }] }
      })

      build.onLoad({ filter: /.*/, namespace: 'dohc-view-sdk' }, () => ({
        contents: VIRTUAL_DOHC_SDK,
        loader: 'js',
      }))

      build.onLoad({ filter: /.*/, namespace: 'dohc-view' }, (args) => {
        const cleanPath = cleanRelativePath(args.path)
        if (!cleanPath) return { errors: [{ text: 'invalid-path' }] }
        const contents = fileMap.get(cleanPath)
        if (contents === undefined) return { errors: [{ text: 'missing-source' }] }
        if (cleanPath.endsWith('.css')) {
          return {
            contents: `
const style = document.createElement('style')
style.textContent = ${jsString(contents)}
document.head.appendChild(style)
`,
            loader: 'js',
          }
        }
        return {
          contents,
          loader: loaderFor(cleanPath),
          resolveDir: dirname(cleanPath),
        }
      })
    },
  }

  try {
    const result = await esbuild.build({
      entryPoints: [cleanEntry],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      target: 'es2020',
      minify: true,
      define: {
        'process.env.NODE_ENV': '"production"',
      },
      plugins: [plugin],
      logLevel: 'silent',
    })
    const code = result.outputFiles[0]?.text ?? ''
    if (bytes(code) > MAX_VIEW_BUNDLE_BYTES) {
      return diagnostic(
        'bundle-too-large',
        'This view is too large to render safely.',
      )
    }
    return { ok: true, code, diagnostics: [] }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    const code =
      text.includes('dynamic-import')
        ? 'dynamic-import'
        : text.includes('absolute-import')
          ? 'absolute-import'
          : text.includes('unsupported-import')
            ? 'unsupported-import'
            : text.includes('remote-import')
              ? 'remote-import'
              : 'build-failed'
    return diagnostic(code, 'This view could not be bundled safely.')
  }
}
