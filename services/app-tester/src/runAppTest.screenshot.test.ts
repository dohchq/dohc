import { describe, expect, it } from 'vitest'
import { runAppTest } from './runAppTest'

describe('runAppTest screenshot artifacts', () => {
  it('attaches a screenshot artifact when browser render checks fail', async () => {
    const result = await runAppTest({
      packageRoot: 'finance/.apps/blank',
      files: [{ relativePath: 'src/App.tsx', body: "import { dohc } from '@dohc/app'; export default function App(){ return <main></main> }" }],
      mode: 'browser',
    })

    expect(result).toMatchObject({
      ok: false,
      artifacts: {
        screenshots: [
          expect.objectContaining({
            name: 'browser-render',
            mimeType: 'image/png',
          }),
        ],
      },
    })
    const dataUrl = result.artifacts?.screenshots?.[0]?.dataUrl ?? ''
    expect(dataUrl).toMatch(/^data:image\/png;base64,/)
    expect(dataUrl).not.toBe('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=')
    expect(dataUrl.length).toBeGreaterThan(200)
  })
})
