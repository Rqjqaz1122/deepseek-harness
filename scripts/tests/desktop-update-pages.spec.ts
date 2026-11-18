/** Pages publication keeps one site owner and installs only the generator's dependencies. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { load } from 'js-yaml'
import { expect, it } from 'vitest'

interface Job {
  if?: string
  needs?: string | string[]
  uses?: string
  with?: Record<string, unknown>
  permissions?: Record<string, string>
  steps?: Array<{ id?: string; name?: string; run?: string; if?: string }>
}
const root = resolve(import.meta.dirname, '../..')
const pages = load(readFileSync(join(root, '.github/workflows/docs-pages.yml'), 'utf8')) as {
  on: { workflow_dispatch: { inputs: { site: { options: string[] } } }; workflow_call: object }
  concurrency: { group: string; 'cancel-in-progress': boolean }
  jobs: Record<string, Job>
}

it('publishes metadata only after the installer job succeeds and shares the Pages deployment owner', () => {
  const release = load(readFileSync(join(root, '.github/workflows/macos-github-release.yml'), 'utf8')) as { jobs: Record<string, Job> }
  expect(release.jobs['publish-update-manifests']).toMatchObject({ needs: 'package', uses: './.github/workflows/docs-pages.yml',
    with: { desktop_updates: true }, permissions: { contents: 'read', pages: 'write', 'id-token': 'write' } })
  expect(pages.on.workflow_dispatch.inputs.site.options).toContain('desktop-updates')
  expect(pages.on.workflow_call).toBeDefined()
  expect(pages.concurrency).toEqual({ group: 'github-pages', 'cancel-in-progress': false })
  expect(pages.jobs.deploy?.needs).toEqual(['build', 'desktop-updates'])
  expect(pages.jobs.deploy?.if).toContain("needs.desktop-updates.result == 'success'")
  expect(pages.jobs['desktop-updates']?.if).toContain("inputs.site == 'desktop-updates'")
  expect(pages.jobs.build?.if).toContain("inputs.site != 'desktop-updates'")
})

it('rejects an unreserved update site and documentation overwrites before checkout or installation', () => {
  for (const [job, condition] of [['desktop-updates', "vars.DESKTOP_UPDATE_PAGES != 'true'"], ['build', "vars.DESKTOP_UPDATE_PAGES == 'true'"]]) {
    const guard = pages.jobs[job!]!.steps![0]!
    expect(guard.if).toBe(condition)
    expect(guard.run).toContain('exit 1')
  }
})

it('installs only semver and zod without repository install hooks or disabled lint dependencies', () => {
  const steps = pages.jobs['desktop-updates']!.steps!
  const source = steps.find(step => step.id === 'generator')!.run!
  const script = source.split("<<'NODE'\n")[1]!.split('\nNODE')[0]!
  const directory = mkdtempSync(join(tmpdir(), 'desktop-pages-tools-'))
  try {
    mkdirSync(join(directory, 'desktop-update-tools'))
    execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: root, env: { ...process.env, RUNNER_TEMP: directory }, stdio: 'pipe',
    })
    const manifest = JSON.parse(readFileSync(join(directory, 'desktop-update-tools/package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(Object.keys(manifest.dependencies)).toEqual(['semver', 'zod'])
    expect(source).toContain('--ignore-scripts')
    expect(steps.filter(step => step.run?.includes('pnpm install'))).toEqual([])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
