import { describe, expect, it, vi } from 'vitest'
import { desktopManualUpdateRepository, githubManualUpdateSource, GitHubReleaseCheckError } from '../src/github-update.ts'
import { desktopManualUpdateConfirmation, en, zh } from '../src/locale.ts'
import { createDesktopUpdateManifests } from '../scripts/generate-update-manifests.ts'
import { githubUpdateManifestUrl } from '../src/github-update-manifest.ts'

function release(tag: string, name = `deepseek-harness-${tag.replace(/^(?:desktop-)?v/u, '')}-mac-arm64-unsigned.dmg`) {
  return { tag_name: tag, draft: false, prerelease: false, assets: [{ name, state: 'uploaded', size: 100, digest: `sha256:${'a'.repeat(64)}` }] }
}

function fixture(releases: unknown = []) {
  const manifests = createDesktopUpdateManifests('example/harness', [releases])
  const request = vi.fn(async (url: string, _init: RequestInit) => Response.json(url.endsWith('/stable.json') ? manifests.stable : manifests.nightly))
  const open = vi.fn(async (_url: string) => {})
  const source = githubManualUpdateSource('example/harness', 'darwin', 'arm64', request, open)
  return { request, open, source, manifests, signal: new AbortController().signal }
}

describe('GitHub Pages manual updates', () => {
  it('validates the installed repository and preserves automatic mode for absent or null settings', () => {
    expect(desktopManualUpdateRepository({})).toBeUndefined()
    expect(desktopManualUpdateRepository({ dshDesktopManualUpdateRepository: null })).toBeUndefined()
    expect(desktopManualUpdateRepository({ dshDesktopManualUpdateRepository: 'example/harness' })).toBe('example/harness')
    for (const value of ['', 'https://github.com/example/harness', 'example/..', '../harness', 'example/harness?token=secret', 1]) {
      expect(() => desktopManualUpdateRepository({ dshDesktopManualUpdateRepository: value })).toThrow()
    }
    expect(() => desktopManualUpdateRepository(null)).toThrow()
    expect(() => githubManualUpdateSource('example/harness', 'linux', 'arm64', fetch, async () => {})).toThrow('require macOS or Windows')
    expect(() => githubManualUpdateSource('example/harness', 'darwin', 'ia32', fetch, async () => {})).toThrow('arm64 or x64')
  })

  it('selects the highest semantic version with an uploaded installer for the installed architecture', async () => {
    const f = fixture([
      release('v1.2.0'), release('desktop-v1.3.0-rc.2'), release('v1.3.0-rc.10'), release('v1.1.0'),
      { ...release('v9.0.0'), draft: true }, release('latest'),
      release('v8.0.0', 'deepseek-harness-8.0.0-mac-x64.dmg'),
      release('v7.0.0', 'deepseek-harness-7.0.0-win-arm64.exe'),
      { ...release('v6.0.0'), assets: [] },
      { ...release('v5.0.0'), assets: [{ name: 'app-mac-arm64.dmg', state: 'open', size: 100 }] },
      { ...release('v4.0.0'), assets: [{ name: 'app-mac-arm64.dmg', state: 'uploaded', size: 0 }] },
    ])
    expect(await f.source.check('nightly', f.signal)).toEqual({ version: '1.3.0-rc.10', pageUrl: 'https://github.com/example/harness/releases/tag/v1.3.0-rc.10' })
    expect(await f.source.check('stable', f.signal)).toEqual({ version: '1.2.0', pageUrl: 'https://github.com/example/harness/releases/tag/v1.2.0' })
    expect(f.request).toHaveBeenCalledWith('https://example.github.io/harness/updates/nightly.json', expect.objectContaining({
      credentials: 'omit', redirect: 'follow', cache: 'no-cache',
    }))
    expect(f.request.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal)
    expect(f.open).not.toHaveBeenCalled()
  })

  it('treats GitHub prerelease flags and semantic prerelease suffixes independently', async () => {
    const f = fixture([{ ...release('v2.0.0'), prerelease: true }, release('desktop-v1.3.0-rc.2')])
    expect(await f.source.check('stable', f.signal)).toBeUndefined()
    expect(await f.source.check('nightly', f.signal)).toMatchObject({ version: '2.0.0' })
    const windows = githubManualUpdateSource('example/harness', 'win32', 'x64',
      async () => Response.json(createDesktopUpdateManifests('example/harness', [[release('v2.0.0', 'deepseek-harness-2.0.0-win-x64.exe')]]).stable), f.open)
    expect(await windows.check('stable', f.signal)).toMatchObject({ version: '2.0.0' })
  })

  it('derives the browser URL from the repository and tag, ignoring response-provided URLs', async () => {
    const f = fixture([{ ...release('desktop-v1.2.0'), html_url: 'https://attacker.invalid', url: 'file:///etc/passwd' }])
    const candidate = await f.source.check('nightly', f.signal)
    expect(candidate).toEqual({ version: '1.2.0', pageUrl: 'https://github.com/example/harness/releases/tag/desktop-v1.2.0' })
  })

  it('reports an empty release list without opening a browser', async () => {
    const f = fixture()
    expect(await f.source.check('nightly', f.signal)).toBeUndefined()
    expect(f.open).not.toHaveBeenCalled()
  })

  it('accepts same-origin Pages redirects and rejects a response from another origin', async () => {
    const f = fixture()
    for (const url of ['https://example.github.io/harness/updates/nightly.json', 'https://attacker.invalid/releases']) {
      const response = Response.json(f.manifests.nightly)
      Object.defineProperties(response, { redirected: { value: true }, url: { value: url } })
      f.request.mockResolvedValueOnce(response)
      if (url.startsWith('https://example.github.io/')) expect(await f.source.check('nightly', f.signal)).toBeUndefined()
      else await expect(f.source.check('nightly', f.signal)).rejects.toMatchObject({ kind: 'response' })
    }
  })

  it.each([403, 404, 429, 500])('reports HTTP %s without claiming no update or exposing response contents', async (status) => {
    const f = fixture()
    f.request.mockResolvedValueOnce(new Response('private upstream diagnostic', { status }))
    await expect(f.source.check('nightly', f.signal)).rejects.toMatchObject({ name: 'GitHubReleaseCheckError', kind: 'http',
      message: `desktop update: update manifest returned HTTP ${status}; check the Pages deployment and retry` })
  })

  it.each([null, {}, [{ tag_name: 'v1.2.0' }], [release('v1.2.0'), { ...release('v2.0.0'), assets: null }]])('rejects invalid release metadata: %j', async (body) => {
    const f = fixture()
    f.request.mockResolvedValueOnce(Response.json(body))
    await expect(f.source.check('nightly', f.signal)).rejects.toMatchObject({ kind: 'response' })
  })

  it('preserves transport failures and cancellation, and rejects malformed JSON', async () => {
    const f = fixture()
    const cause = new TypeError('network failure')
    f.request.mockRejectedValueOnce(cause)
    await expect(f.source.check('nightly', f.signal)).rejects.toMatchObject({ kind: 'network', cause })
    f.request.mockResolvedValueOnce(new Response('{'))
    await expect(f.source.check('nightly', f.signal)).rejects.toBeInstanceOf(GitHubReleaseCheckError)
    const controller = new AbortController()
    controller.abort()
    f.request.mockImplementationOnce(async (_url, init) => {
      expect(init.signal?.aborted).toBe(true)
      throw init.signal?.reason
    })
    await expect(f.source.check('nightly', controller.signal)).rejects.toMatchObject({ kind: 'network' })
  })

  it('records the manual confirmation and no-update feedback in both primary locales', async () => {
    const text = [en, zh].map(messages => ({ ...desktopManualUpdateConfirmation(messages, '0.2.3-rc.1'),
      current: messages.updateManualCurrent, openFailed: messages.updateOpenReleaseFailed }))
    await expect(JSON.stringify(text, null, 2) + '\n').toMatchFileSnapshot('./expected/github-update-dialogs.json')
  })

  it('resolves project and user Pages sites without calling the REST API', () => {
    expect(githubUpdateManifestUrl('Example/harness', 'stable')).toBe('https://example.github.io/harness/updates/stable.json')
    expect(githubUpdateManifestUrl('Example/example.github.io', 'nightly')).toBe('https://example.github.io/updates/nightly.json')
  })

  it('revalidates channel-specific ETags and replaces the cached release after publication', async () => {
    const f = fixture([release('v1.2.0')])
    f.request.mockResolvedValueOnce(Response.json(f.manifests.nightly, { headers: { ETag: '"first"' } }))
    expect(await f.source.check('nightly', f.signal)).toMatchObject({ version: '1.2.0' })
    await f.source.check('stable', f.signal)
    expect(f.request.mock.calls[1]?.[1].headers).toEqual({ Accept: 'application/json' })
    f.request.mockResolvedValueOnce(new Response(null, { status: 304 }))
    expect(await f.source.check('nightly', f.signal)).toMatchObject({ version: '1.2.0' })
    expect(f.request.mock.calls[2]?.[1].headers).toEqual({ Accept: 'application/json', 'If-None-Match': '"first"' })
    const next = createDesktopUpdateManifests('example/harness', [[release('v1.3.0')]]).nightly
    f.request.mockResolvedValueOnce(Response.json(next))
    expect(await f.source.check('nightly', f.signal)).toMatchObject({ version: '1.3.0' })
    await f.source.check('nightly', f.signal)
    expect(f.request.mock.calls[4]?.[1].headers).toEqual({ Accept: 'application/json' })
  })

  it('does not use cached metadata when revalidation fails or accept an unsolicited 304', async () => {
    const f = fixture([release('v1.2.0')])
    f.request.mockResolvedValueOnce(new Response(null, { status: 304 }))
    await expect(f.source.check('nightly', f.signal)).rejects.toMatchObject({ kind: 'http' })
    f.request.mockResolvedValueOnce(Response.json(f.manifests.nightly, { headers: { ETag: '"cached"' } }))
    await f.source.check('nightly', f.signal)
    f.request.mockResolvedValueOnce(new Response(null, { status: 503 }))
    await expect(f.source.check('nightly', f.signal)).rejects.toMatchObject({ kind: 'http' })
  })

  it('rejects mismatched repositories, channels, versions, addresses, checksums and target filenames', async () => {
    const f = fixture([release('v1.2.0')])
    const original = f.manifests.nightly
    const entry = original.releases[0]!
    const asset = entry.installers[0]!
    const mutations = [
      { ...original, schemaVersion: 2 }, { ...original, repository: 'attacker/harness' }, { ...original, channel: 'stable' },
      { ...original, releases: [{ ...entry, version: 'invalid' }] },
      { ...original, releases: [{ ...entry, tag: 'v9.0.0' }] },
      ...[{ url: 'https://attacker.invalid/app.dmg' }, { sha256: 'invalid' }, { size: 0 }, { arch: 'x64' }]
        .map(fields => ({ ...original, releases: [{ ...entry, installers: [{ ...asset, ...fields }] }] })),
    ]
    for (const body of mutations) {
      f.request.mockResolvedValueOnce(Response.json(body))
      await expect(f.source.check('nightly', f.signal)).rejects.toMatchObject({ kind: 'response' })
    }
    f.request.mockResolvedValueOnce(Response.json({ ...original, channel: 'stable', releases: [{ ...entry, prerelease: true }] }))
    await expect(f.source.check('stable', f.signal)).rejects.toMatchObject({ kind: 'response' })
    const preview = createDesktopUpdateManifests('example/harness', [[release('v2.0.0-rc.1')]]).nightly
    preview.releases[0]!.prerelease = false
    f.request.mockResolvedValueOnce(Response.json(preview))
    await expect(f.source.check('nightly', f.signal)).rejects.toMatchObject({ kind: 'response' })
  })
})
