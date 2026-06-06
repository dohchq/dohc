import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const routeSource = readFileSync(resolve(__dirname, '../routes/_app.tsx'), 'utf8')

describe('Apps shell', () => {
  it('uses the first-class AppFrame component for app routes', () => {
    expect(() => readFileSync(resolve(__dirname, '../components/AppFrame.tsx'), 'utf8')).not.toThrow()
    expect(routeSource).toContain("import { AppFrame } from '@/components/AppFrame'")
    expect(routeSource).toContain('<AppFrame')
    expect(routeSource).not.toContain('<ViewFrame')
  })
})
