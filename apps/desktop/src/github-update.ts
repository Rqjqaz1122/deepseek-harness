/** Public GitHub Pages discovery for packages whose updates are installed manually. */
import { gt } from 'semver'
import { z } from 'zod'
import type { DesktopManualUpdateSource } from './update-coordinator.ts'
import { githubUpdateManifestUrl, githubUpdateRepository, parseDesktopUpdateManifest } from './github-update-manifest.ts'
import type { DesktopUpdateManifest } from './github-update-manifest.ts'
import type { DesktopUpdateChannel } from './update-channel.ts'

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
  const parsed = z.object({ dshDesktopManualUpdateRepository: githubUpdateRepository.nullish() }).parse(manifest)
  return parsed.dshDesktopManualUpdateRepository ?? undefined
}

/**
 * Construct a source using Electron's proxy-aware fetch and browser opener supplied by the main process.
 * @param repository - Public GitHub owner/repository; private repositories and tokens are unsupported.
 * @param platform - Installed operating system.
 * @param arch - Installed process architecture.
 * @param request - HTTP transport; Pages requests contain no account credentials and reject cross-origin redirects.
 * @param openPage - Opens the main-owned release URL after user confirmation.
 * @returns Source selecting the highest compatible version from channel metadata, revalidating cached responses with ETags.
 */
export function githubManualUpdateSource(repository: string, platform: NodeJS.Platform, arch: string,
  request: (url: string, init: RequestInit) => Promise<Response>, openPage: (url: string) => Promise<void>): DesktopManualUpdateSource {
  githubUpdateRepository.parse(repository)
  if (!['darwin', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
    throw new Error('desktop update: GitHub manual updates require macOS or Windows and arm64 or x64')
  }
  const cache = new Map<DesktopUpdateChannel, { etag: string; manifest: DesktopUpdateManifest }>()
  return {
    openPage,
    async check(channel, signal) {
      let response: Response
      const url = githubUpdateManifestUrl(repository, channel)
      const cached = cache.get(channel)
      try {
        response = await request(url, {
          headers: { Accept: 'application/json', ...(cached === undefined ? {} : { 'If-None-Match': cached.etag }) },
          credentials: 'omit', redirect: 'follow', cache: 'no-cache',
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        })
      } catch (cause) {
        throw new GitHubReleaseCheckError('network', 'desktop update: update manifest request failed; check the connection and retry', { cause })
      }
      if (response.redirected && new URL(response.url).origin !== new URL(url).origin) {
        throw new GitHubReleaseCheckError('response', 'desktop update: update manifest redirected outside its Pages origin')
      }
      let manifest: DesktopUpdateManifest
      if (response.status === 304 && cached !== undefined) {
        manifest = cached.manifest
      } else {
        if (!response.ok) throw new GitHubReleaseCheckError('http', `desktop update: update manifest returned HTTP ${response.status}; check the Pages deployment and retry`)
        try {
          const body: unknown = await response.json()
          manifest = parseDesktopUpdateManifest(body, repository, channel)
        } catch (cause) {
          throw new GitHubReleaseCheckError('response', 'desktop update: update manifest is invalid', { cause })
        }
        const etag = response.headers.get('etag')
        if (etag === null) cache.delete(channel)
        else cache.set(channel, { etag, manifest })
      }
      let selected: { version: string; pageUrl: string } | undefined
      for (const release of manifest.releases) {
        const version = release.version
        if (!release.installers.some(asset => asset.platform === platform && asset.arch === arch)) continue
        if (selected === undefined || gt(version, selected.version)) {
          selected = { version, pageUrl: `https://github.com/${repository}/releases/tag/${encodeURIComponent(release.tag)}` }
        }
      }
      return selected
    },
  }
}
