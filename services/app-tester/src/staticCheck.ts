import ts from 'typescript'

// The Playwright-free half of AppTester. It transpiles an app's source and
// confirms it targets the @dohc/app SDK — catching legacy SDK imports and
// syntactically broken source without launching a browser. Note: ts.transpileModule
// is syntax-only — it does NOT resolve imports or type-check, so full
// build/module-resolution validation is the Phase 7b runtime's job, not this
// gate. The desktop imports ONLY this module (via @dohc/app-tester/static) so
// its bundle never pulls in the browser runtime that dynamically imports
// @playwright/test.

export type AppTestFile = {
  relativePath: string
  body: string
}

export type AppTestCheck = {
  name: string
  status: 'ok' | 'failed'
  code?: string
  message?: string
}

function isCodeFile(file: AppTestFile): boolean {
  return /\.(?:[cm]?[jt]sx?)$/i.test(file.relativePath)
}

function stripDohcFrontmatter(body: string): string {
  if (!body.startsWith('---\n') && !body.startsWith('---\r\n')) return body
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(body)
  return match ? body.slice(match[0].length) : body
}

export function source(files: AppTestFile[]): string {
  return files.filter(isCodeFile).map((file) => stripDohcFrontmatter(file.body)).join('\n')
}

function codeFiles(files: AppTestFile[]): AppTestFile[] {
  return files
    .filter(isCodeFile)
    .map((file) => ({ ...file, body: stripDohcFrontmatter(file.body) }))
}

function importSpecifiers(file: AppTestFile): string[] {
  const sourceFile = ts.createSourceFile(
    file.relativePath,
    file.body,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  )
  const specifiers: string[] = []
  const stringLiteralText = (node: ts.Node): string | undefined => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
    return undefined
  }
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text)
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0
    ) {
      const firstArgument = node.arguments[0]
      const specifier = firstArgument ? stringLiteralText(firstArgument) : undefined
      if (specifier !== undefined) specifiers.push(specifier)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return specifiers
}

function isLegacyImport(specifier: string): boolean {
  return specifier === '@dohc/view' || specifier.startsWith('@dohc/view/') || /\.views(?:\/|$)/.test(specifier)
}

export function checkCompileFiles(files: AppTestFile[]): AppTestCheck {
  const filesToCompile = codeFiles(files)
  const specifiers = filesToCompile.flatMap(importSpecifiers)
  if (specifiers.some(isLegacyImport)) {
    return {
      name: 'compile',
      status: 'failed',
      code: 'legacy-view-import',
      message: 'App must use .apps and @dohc/app, not legacy view APIs.',
    }
  }
  if (!specifiers.includes('@dohc/app')) {
    return {
      name: 'compile',
      status: 'failed',
      code: 'missing-app-sdk',
      message: 'App must import @dohc/app.',
    }
  }
  for (const file of filesToCompile) {
    const compiled = ts.transpileModule(file.body, {
      fileName: file.relativePath,
      reportDiagnostics: true,
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        isolatedModules: true,
      },
    })
    const diagnostic = compiled.diagnostics?.find(
      (item) => item.category === ts.DiagnosticCategory.Error,
    )
    if (diagnostic) {
      return {
        name: 'compile',
        status: 'failed',
        code: 'compile-error',
        message: `${file.relativePath}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
      }
    }
  }
  return { name: 'compile', status: 'ok' }
}

export function checkCompile(code: string): AppTestCheck {
  return checkCompileFiles([{ relativePath: 'App.tsx', body: code }])
}

export type StaticCheckResult = {
  ok: boolean
  checks: AppTestCheck[]
  failures: AppTestCheck[]
}

// Compile-only gate. Mirrors runAppTest's static mode, but importable on its
// own so callers that never render apps (the desktop) stay browser-free.
export function runStaticAppCheck(files: AppTestFile[]): StaticCheckResult {
  const compile = checkCompileFiles(files)
  const failures = compile.status === 'failed' ? [compile] : []
  return { ok: failures.length === 0, checks: [compile], failures }
}
