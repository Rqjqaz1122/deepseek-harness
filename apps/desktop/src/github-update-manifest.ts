/** Versioned GitHub Pages manifests shared by the Desktop reader and publication script. */
import { prerelease, valid } from 'semver'
import { z } from 'zod'
import type { DesktopUpdateChannel } from './update-channel.ts'

/** Public GitHub owner/repository without credentials, query strings, or path traversal. */
export const githubUpdateRepository = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/u)
  .refine(value => !['.', '..'].includes(value.split('/')[1] ?? ''))

const installer = z.object({
  platform: z.enum(['darwin', 'win32']), arch: z.enum(['arm64', 'x64']),
  name: z.string(), size: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/u), url: z.string(),
})
const release = z.object({
  version: z.string().refine(value => valid(value) === value), tag: z.string(), prerelease: z.boolean(),
  installers: z.array(installer).min(1),
})
const manifest = z.object({
  schemaVersion: z.literal(1), repository: githubUpdateRepository, channel: z.enum(['stable', 'nightly']),
  releases: z.array(release),
})

/** Published metadata; download addresses and platform filenames are validated before use. */
export type DesktopUpdateManifest = z.infer<typeof manifest>

/**
 * Validate JSON and its repository, channel, versions, and installer addresses.
 * @param value - Untrusted Pages response or generated publication data.
 * @param repository - Installed application's public repository.
 * @param channel - Requested update channel.
 * @returns Validated metadata; invalid or mismatched entries throw without establishing currency.
 */
export function parseDesktopUpdateManifest(value: unknown, repository: string, channel: DesktopUpdateChannel): DesktopUpdateManifest {
  const parsed = manifest.parse(value)
  if (parsed.repository !== repository || parsed.channel !== channel) throw new Error('desktop update: manifest repository or channel does not match')
  for (const entry of parsed.releases) {
    if (valid(entry.tag.replace(/^(?:desktop-)?v/u, '')) !== entry.version
      || (prerelease(entry.version) !== null && !entry.prerelease)
      || (channel === 'stable' && entry.prerelease)) throw new Error('desktop update: manifest release version or channel is invalid')
    for (const asset of entry.installers) {
      const target = `${asset.platform === 'darwin' ? 'mac' : 'win'}-${asset.arch}`
      const extension = asset.platform === 'darwin' ? 'dmg' : 'exe'
      const stem = `deepseek-harness-${entry.version}-${target}`
      if (![`${stem}.${extension}`, `${stem}-unsigned.${extension}`].includes(asset.name)
        || asset.url !== `https://github.com/${repository}/releases/download/${encodeURIComponent(entry.tag)}/${encodeURIComponent(asset.name)}`) {
        throw new Error('desktop update: manifest installer filename or address is invalid')
      }
    }
  }
  return parsed
}

/**
 * Resolve the default Pages project location, including GitHub user/organization sites.
 * @param repository - Public GitHub owner/repository.
 * @param channel - Requested update channel.
 * @returns HTTPS address of the channel's static manifest.
 */
export function githubUpdateManifestUrl(repository: string, channel: DesktopUpdateChannel): string {
  githubUpdateRepository.parse(repository)
  const [owner, name] = repository.split('/')
  const hostname = `${owner!.toLowerCase()}.github.io`
  return `https://${hostname}/${name!.toLowerCase() === hostname ? '' : `${name!}/`}updates/${channel}.json`
}
