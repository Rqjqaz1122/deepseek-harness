/** Build public Pages metadata from authenticated GitHub release listings; never download installers. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { prerelease, valid } from 'semver'
import { z } from 'zod'
import { githubUpdateRepository, parseDesktopUpdateManifest } from '../src/github-update-manifest.ts'
import type { DesktopUpdateManifest } from '../src/github-update-manifest.ts'

const releasePages = z.array(z.array(z.object({
  tag_name: z.string(), draft: z.boolean(), prerelease: z.boolean(),
  assets: z.array(z.object({ name: z.string(), state: z.string(), size: z.number().int().nonnegative(), digest: z.string().nullish() })),
})))

/**
 * Produce both channels from every paginated release returned by GitHub.
 * @param repository - Public owner/repository owning the releases.
 * @param pages - JSON from `gh api --paginate --slurp repos/<repository>/releases`.
 * @returns Stable and prerelease-inclusive manifests; eligible installers without a SHA-256 digest reject publication.
 */
export function createDesktopUpdateManifests(repository: string, pages: unknown): Record<'stable' | 'nightly', DesktopUpdateManifest> {
  githubUpdateRepository.parse(repository)
  const entries: DesktopUpdateManifest['releases'] = []
  for (const release of releasePages.parse(pages).flat()) {
    const version = valid(release.tag_name.replace(/^(?:desktop-)?v/u, ''))
    if (release.draft || version === null) continue
    const installers: DesktopUpdateManifest['releases'][number]['installers'] = []
    for (const asset of release.assets) {
      if (asset.state !== 'uploaded' || asset.size === 0) continue
      const match = /^deepseek-harness-(.+)-(mac|win)-(arm64|x64)(?:-unsigned)?\.(dmg|exe)$/u.exec(asset.name)
      if (match === null || match[1] !== version || (match[2] === 'mac' ? match[4] !== 'dmg' : match[4] !== 'exe')) continue
      if (!/^sha256:[a-f0-9]{64}$/u.test(asset.digest ?? '')) {
        throw new Error(`desktop update publication: missing GitHub SHA-256 digest for ${release.tag_name}/${asset.name}`)
      }
      installers.push({ platform: match[2] === 'mac' ? 'darwin' : 'win32', arch: match[3] === 'arm64' ? 'arm64' : 'x64',
        name: asset.name, size: asset.size, sha256: asset.digest!.slice('sha256:'.length),
        url: `https://github.com/${repository}/releases/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(asset.name)}` })
    }
    if (installers.length > 0) entries.push({ version, tag: release.tag_name,
      prerelease: release.prerelease || prerelease(version) !== null, installers })
  }
  return {
    stable: parseDesktopUpdateManifest({ schemaVersion: 1, repository, channel: 'stable', releases: entries.filter(entry => !entry.prerelease) }, repository, 'stable'),
    nightly: parseDesktopUpdateManifest({ schemaVersion: 1, repository, channel: 'nightly', releases: entries }, repository, 'nightly'),
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { repository: { type: 'string' }, input: { type: 'string' }, output: { type: 'string' } } })
  if (values.repository === undefined || values.input === undefined || values.output === undefined) {
    throw new Error('Usage: generate-update-manifests.ts --repository owner/repository --input release-pages.json --output site-directory')
  }
  const pages: unknown = JSON.parse(readFileSync(values.input, 'utf8'))
  const manifests = createDesktopUpdateManifests(values.repository, pages)
  mkdirSync(join(values.output, 'updates'), { recursive: true })
  for (const channel of ['stable', 'nightly'] as const) {
    writeFileSync(join(values.output, 'updates', `${channel}.json`), `${JSON.stringify(manifests[channel], null, 2)}\n`)
  }
  writeFileSync(join(values.output, '.nojekyll'), '')
}
