/** Exercise the Release workflow's version guard without installing or packaging. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { load } from 'js-yaml'
import { expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const workflow = load(readFileSync(join(root, '.github/workflows/macos-github-release.yml'), 'utf8')) as {
  on: { release: { types: string[] } }
  jobs: { package: { steps: Array<{ id?: string; run?: string }> } }
}
const command = workflow.jobs.package.steps.find(step => step.id === 'version')!.run!
const source = command.split("<<'NODE'\n")[1]!.split('\nNODE')[0]!

function validate(tag: string, prerelease: boolean, arch = 'arm64'): string {
  const directory = mkdtempSync(join(tmpdir(), 'macos-release-guard-'))
  try {
    const event = join(directory, 'event.json')
    const output = join(directory, 'output')
    writeFileSync(event, JSON.stringify({ release: { prerelease } }))
    // The guard runs on all CI hosts; this child owns its simulated runner identity.
    const runner = `Object.defineProperty(process, 'platform', {value: 'darwin'}); Object.defineProperty(process, 'arch', {value: ${JSON.stringify(arch)}});\n`
    execFileSync(process.execPath, ['--input-type=module', '--eval', runner + source], {
      cwd: root,
      env: { ...process.env, RELEASE_TAG: tag, GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output },
      stdio: 'pipe',
    })
    return readFileSync(output, 'utf8')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const product = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version
const version = `${product}${product.includes('-') ? '.' : '-test.'}20261116.1`

it('builds both stable and prerelease publication events', () => {
  expect(workflow.on.release.types).toEqual(['published'])
})

it('forwards the exact extended version selected by the release tag', () => {
  expect(validate(`desktop-v${version}`, true)).toBe(`version=${version}\n`)
})

it.each(['v1.0.0', 'desktop-v999.0.0', 'desktop-v1.0.0\ninjected=value', 'desktop-v$(id)'])(
  'rejects invalid or incompatible tag %s before publishing outputs', (tag) => {
    expect(() => validate(tag, true)).toThrow()
  },
)

it('requires prerelease status for prerelease versions', () => {
  expect(() => validate(`desktop-v${version}`, false)).toThrow('Mark prerelease versions')
})

it('rejects an Intel runner before packaging', () => {
  expect(() => validate(`desktop-v${version}`, true, 'x64')).toThrow('Apple Silicon runner')
})
