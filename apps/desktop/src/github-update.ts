/** Public GitHub Releases discovery for packages whose updates are installed manually. */
import { gt, prerelease, valid } from 'semver'
import { z } from 'zod'
import type { DesktopManualUpdateSource } from './update-coordinator.ts'

const repositoryName = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/u)
  .refine(value => !['.', '..'].includes(value.split('/')[1] ?? ''))
const releases = z.array(z.object({
  tag_name: z.string(), draft: z.boolean(), prerelease: z.boolean(),
  assets: z.array(z.object({ name: z.string(), state: z.string(), size: z.number().nonnegative() })),
}))

/** A failed lookup never establishes that the installed version is current. */
export class GitHubReleaseCheckError extends Error {
  /**
   * @param kind - Transport, HTTP status, or invalid GitHub response.
   * @param message - Safe diagnostic without response bodies or credentials.
   * @param options - Original failure when available.
   */
  constructor(readonly kind: 'network' | 'http' | 'response', message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'GitHubReleaseCheckError'
  }
}

/**
 * Read an optional repository from the installed manifest; explicit invalid settings reject.
 * @param manifest - Parsed packaged application manifest.
 * @returns Public owner/repository, or undefined for native automatic updates.
 */
export function desktopManualUpdateRepository(manifest: unknown): string | undefined {
  const parsed = z.object({ dshDesktopManualUpdateRepository: repositoryName.nullish() }).parse(manifest)
  return parsed.dshDesktopManualUpdateRepository ?? undefined
}

/**
 * Construct a source using Electron's proxy-aware fetch and browser opener supplied by the main process.
 * @param repository - Public GitHub owner/repository; private repositories and tokens are unsupported.
 * @param platform - Installed operating system.
 * @param arch - Installed process architecture.
 * @param request - HTTP transport; requests contain no account credentials and allow GitHub repository redirects.
 * @param openPage - Opens the main-owned release URL after user confirmation.
 * @returns Source selecting the highest compatible version among the latest 100 published releases.
 */
export function githubManualUpdateSource(repository: string, platform: NodeJS.Platform, arch: string,
  request: (url: string, init: RequestInit) => Promise<Response>, openPage: (url: string) => Promise<void>): DesktopManualUpdateSource {
  repositoryName.parse(repository)
  if (!['darwin', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
    throw new Error('desktop update: GitHub manual updates require macOS or Windows and arm64 or x64')
  }
  const suffix = new RegExp(`-${platform === 'darwin' ? 'mac' : 'win'}-${arch}(?:-unsigned)?\\.${platform === 'darwin' ? 'dmg' : 'exe'}$`, 'u')
  return {
    openPage,
    async check(channel, signal) {
      let response: Response
      try {
        response = await request(`https://api.github.com/repos/${repository}/releases?per_page=100`, {
          headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
          credentials: 'omit', redirect: 'follow', cache: 'no-store',
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        })
      } catch (cause) {
        throw new GitHubReleaseCheckError('network', 'desktop update: GitHub network request failed; check the connection and retry', { cause })
      }
      if (response.redirected && new URL(response.url).origin !== 'https://api.github.com') {
        throw new GitHubReleaseCheckError('response', 'desktop update: GitHub redirected outside its API origin')
      }
      if (!response.ok) throw new GitHubReleaseCheckError('http', `desktop update: GitHub returned HTTP ${response.status}; retry later or check repository visibility and rate limits`)
      let body: unknown
      try { body = await response.json() } catch (cause) {
        throw new GitHubReleaseCheckError('response', 'desktop update: GitHub returned invalid JSON', { cause })
      }
      const parsed = releases.safeParse(body)
      if (!parsed.success) throw new GitHubReleaseCheckError('response', 'desktop update: GitHub release fields are invalid')
      let selected: { version: string; pageUrl: string } | undefined
      for (const release of parsed.data) {
        const version = valid(release.tag_name.replace(/^(?:desktop-)?v/u, ''))
        if (release.draft || version === null || (channel === 'stable' && (release.prerelease || prerelease(version) !== null))) continue
        if (!release.assets.some(asset => asset.state === 'uploaded' && asset.size > 0 && suffix.test(asset.name))) continue
        if (selected === undefined || gt(version, selected.version)) {
          selected = { version, pageUrl: `https://github.com/${repository}/releases/tag/${encodeURIComponent(release.tag_name)}` }
        }
      }
      return selected
    },
  }
}
