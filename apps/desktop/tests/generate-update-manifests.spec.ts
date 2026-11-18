/** Publication fixtures exercise the same parser used by the installed application. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { createDesktopUpdateManifests } from '../scripts/generate-update-manifests.ts'

const repository = 'example/harness'
function release(tag = 'desktop-v1.2.0', name = `deepseek-harness-${tag.replace(/^(?:desktop-)?v/u, '')}-mac-arm64-unsigned.dmg`) {
  return { tag_name: tag, draft: false, prerelease: false,
    assets: [{ name, state: 'uploaded', size: 123, digest: `sha256:${'a'.repeat(64)}` }] }
}

it('includes all pages, separates preview releases, and retains verified platform-specific download metadata', () => {
  const preview = release('desktop-v2.0.0-rc.1')
  const flagged = { ...release('v1.9.0'), prerelease: true }
  const windows = release('v1.4.0', 'deepseek-harness-1.4.0-win-x64.exe')
  const manifests = createDesktopUpdateManifests(repository, [[release(), preview], [flagged, windows]])
  expect(manifests.nightly.releases.map(entry => entry.version)).toEqual(['1.2.0', '2.0.0-rc.1', '1.9.0', '1.4.0'])
  expect(manifests.stable.releases.map(entry => entry.version)).toEqual(['1.2.0', '1.4.0'])
  expect(manifests.stable.releases[1]?.installers[0]).toEqual({ platform: 'win32', arch: 'x64',
    name: 'deepseek-harness-1.4.0-win-x64.exe', size: 123, sha256: 'a'.repeat(64),
    url: 'https://github.com/example/harness/releases/download/v1.4.0/deepseek-harness-1.4.0-win-x64.exe' })
})

it('excludes drafts, unversioned tags, mismatched installer versions, incomplete uploads, and other artifacts', () => {
  const item = release()
  const manifests = createDesktopUpdateManifests(repository, [[{ ...item, draft: true }, release('latest'),
    release('v1.2.0', 'deepseek-harness-9.0.0-mac-arm64.dmg'), release('v1.2.0', 'deepseek-harness-1.2.0-mac-arm64.exe'),
    release('v1.2.0', 'source.zip'), { ...item, assets: [] },
    { ...item, assets: [{ ...item.assets[0]!, state: 'open' }] }, { ...item, assets: [{ ...item.assets[0]!, size: 0 }] }]])
  expect(manifests.nightly.releases).toEqual([])
  expect(manifests.stable.releases).toEqual([])
})

it.each([null, undefined, '', 'sha256:short', `sha512:${'a'.repeat(64)}`])('rejects an eligible installer with digest %s', (digest) => {
  const item = release()
  expect(() => createDesktopUpdateManifests(repository, [[{ ...item, assets: [{ ...item.assets[0]!, digest }] }]]))
    .toThrow('missing GitHub SHA-256 digest')
})

it.each([null, {}, [[] , {}], [[{ tag_name: 'v1.2.0' }]]])('rejects malformed API pagination data: %j', (pages) => {
  expect(() => createDesktopUpdateManifests(repository, pages)).toThrow()
})

it('writes both channel files through the publication CLI without accessing the network', () => {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-update-manifests-'))
  try {
    const input = join(directory, 'releases.json')
    const output = join(directory, 'site')
    const pages = [[release(), release('v2.0.0-rc.1')]]
    writeFileSync(input, JSON.stringify(pages))
    execFileSync(process.execPath, [resolve(import.meta.dirname, '../scripts/generate-update-manifests.ts'),
      '--repository', repository, '--input', input, '--output', output], { stdio: 'pipe' })
    const expected = createDesktopUpdateManifests(repository, pages)
    for (const channel of ['stable', 'nightly'] as const) {
      expect(JSON.parse(readFileSync(join(output, 'updates', `${channel}.json`), 'utf8'))).toEqual(expected[channel])
    }
    expect(readFileSync(join(output, '.nojekyll'), 'utf8')).toBe('')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
