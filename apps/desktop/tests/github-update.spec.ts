import { describe, expect, it, vi } from 'vitest'
import { desktopManualUpdateRepository, githubManualUpdateSource, GitHubReleaseCheckError } from '../src/github-update.ts'
import { desktopManualUpdateConfirmation, en, zh } from '../src/locale.ts'

function release(tag: string, name = 'deepseek-harness-1.2.0-mac-arm64-unsigned.dmg') {
  return { tag_name: tag, draft: false, prerelease: false, assets: [{ name, state: 'uploaded', size: 100 }] }
}

function fixture(body: unknown = []) {
  const request = vi.fn(async (_url: string, _init: RequestInit) => Response.json(body))
  const open = vi.fn(async (_url: string) => {})
  const source = githubManualUpdateSource('example/harness', 'darwin', 'arm64', request, open)
  return { request, open, source, signal: new AbortController().signal }
}

describe('GitHub manual updates', () => {
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
    expect(f.request).toHaveBeenCalledWith('https://api.github.com/repos/example/harness/releases?per_page=100', expect.objectContaining({
      credentials: 'omit', redirect: 'follow', cache: 'no-store',
    }))
    expect(f.request.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal)
    expect(f.open).not.toHaveBeenCalled()
  })

  it('treats GitHub prerelease flags and semantic prerelease suffixes independently', async () => {
    const f = fixture([{ ...release('v2.0.0'), prerelease: true }, release('desktop-v1.3.0-rc.2')])
    expect(await f.source.check('stable', f.signal)).toBeUndefined()
    expect(await f.source.check('nightly', f.signal)).toMatchObject({ version: '2.0.0' })
    const windows = githubManualUpdateSource('example/harness', 'win32', 'x64',
      async () => Response.json([release('v2.0.0', 'deepseek-harness-2.0.0-win-x64.exe')]), f.open)
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

  it('accepts GitHub repository redirects and rejects a response from another origin', async () => {
    const f = fixture()
    for (const url of ['https://api.github.com/repositories/123/releases', 'https://attacker.invalid/releases']) {
      const response = Response.json([])
      Object.defineProperties(response, { redirected: { value: true }, url: { value: url } })
      f.request.mockResolvedValueOnce(response)
      if (url.startsWith('https://api.github.com/')) expect(await f.source.check('nightly', f.signal)).toBeUndefined()
      else await expect(f.source.check('nightly', f.signal)).rejects.toMatchObject({ kind: 'response' })
    }
  })

  it.each([403, 404, 429, 500])('reports HTTP %s without claiming no update or exposing response contents', async (status) => {
    const f = fixture()
    f.request.mockResolvedValueOnce(new Response('private upstream diagnostic', { status }))
    await expect(f.source.check('nightly', f.signal)).rejects.toMatchObject({ name: 'GitHubReleaseCheckError', kind: 'http',
      message: `desktop update: GitHub returned HTTP ${status}; retry later or check repository visibility and rate limits` })
  })

  it.each([null, {}, [{ tag_name: 'v1.2.0' }], [release('v1.2.0'), { ...release('v2.0.0'), assets: null }]])('rejects invalid release metadata: %j', async (body) => {
    const f = fixture(body)
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
})
