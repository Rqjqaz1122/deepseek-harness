/** Production manual-update dialogs with inert browser handoff and isolated user data. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, nativeTheme, protocol } from 'electron'
import { githubManualUpdateSource } from '../../lib/types/github-update.js'
import { DesktopUpdateCoordinator } from '../../lib/types/update-coordinator.js'
import { DesktopUpdateDialog } from '../../lib/types/update-dialog.js'
import { DesktopUpdateOverlays } from '../../lib/types/update-overlay.js'
import { desktopManualUpdateConfirmation, formatDesktopMessage, resolveDesktopLocale } from '../../lib/types/locale.js'
import { desktopUpdateErrorSummary } from '../../lib/types/update-presentation.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-github-update-ui-'))
app.setPath('userData', join(root, 'user-data'))
protocol.registerSchemesAsPrivileged([{ scheme: 'dsh-app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const deadline = setTimeout(() => { console.error('Manual update dialog qualification timed out'); app.exit(1) }, 45_000)
  const parent = new BrowserWindow({ show: true, width: 480, height: 520 })
  let locale = resolveDesktopLocale('zh-CN')
  const dialogs = new DesktopUpdateDialog(fileURLToPath(new URL('../../lib/preload-update-dialog.cjs', import.meta.url)), () => locale, new DesktopUpdateOverlays())
  const opened = []
  let response = Response.json([{ tag_name: 'v0.2.3-rc.1', draft: false, prerelease: true,
    assets: [{ name: 'deepseek-harness-0.2.3-rc.1-mac-arm64-unsigned.dmg', state: 'uploaded', size: 100 }] }])
  const source = githubManualUpdateSource('example/harness', 'darwin', 'arm64', async () => response, async url => { opened.push(url) })
  const coordinator = new DesktopUpdateCoordinator(state => state, async () => { throw new Error('Unexpected installation') },
    undefined, () => true, () => '0.2.2-rc.2', undefined, 'nightly', undefined, source)
  protocol.handle('dsh-app', async request => {
    const name = new URL(request.url).pathname.slice(1)
    assert.ok(['design-platform.css', 'shell-theme.js', 'update-dialog.html', 'update-dialog.js', 'update-dialog.css', 'update-close.svg'].includes(name))
    const mime = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml' : 'text/html'
    return new Response(await readFile(new URL(`${name === 'design-platform.css' ? '../../lib/welcome' : '../../renderer'}/${name}`, import.meta.url)), { headers: { 'content-type': mime } })
  })
  const results = []
  try {
    await parent.loadURL('data:text/html;charset=utf-8,<title>Manual update dialog qualification</title>')
    const expected = JSON.parse(await readFile(new URL('../expected/github-update-dialogs.json', import.meta.url), 'utf8'))
    const available = await coordinator.check(true)
    assert.equal(available.phase, 'available')
    for (const [language, theme, confirm, expectedIndex] of [['zh-CN', 'light', false, 1], ['zh-CN', 'dark', true, 1], ['en', 'light', true, 0]]) {
      locale = resolveDesktopLocale(language)
      nativeTheme.themeSource = theme
      const options = { title: locale.messages.updateCheckTitle, ...desktopManualUpdateConfirmation(locale.messages, available.version) }
      await show(`${language}-${theme}`, options, confirm, expected[expectedIndex])
      if (confirm) await coordinator.openReleasePage(available.version, coordinator.revision)
      assert.equal(opened.length, confirm ? expectedIndex === 1 ? 1 : 2 : 0)
    }
    locale = resolveDesktopLocale('zh-CN')
    nativeTheme.themeSource = 'light'
    response = Response.json([])
    assert.equal((await coordinator.check(true)).phase, 'idle')
    await show('no-release', { title: locale.messages.updateCheckTitle, message: locale.messages.updateManualCurrent,
      detail: formatDesktopMessage(locale.messages.updateCurrentDetail, { version: '0.2.2-rc.2' }) }, false)
    response = new Response('private diagnostic', { status: 403 })
    const failed = await coordinator.check(true)
    assert.equal(failed.phase, 'error')
    await show('check-failed', { title: locale.messages.updateCheckTitle, message: desktopUpdateErrorSummary(failed, locale.messages) }, false)
    assert.equal(opened.length, 2)
    await writeFile(join(root, 'result.json'), JSON.stringify({ results, opened }, null, 2) + '\n')
    console.log(`GitHub update dialog qualification passed: ${root}`)
  } finally {
    clearTimeout(deadline)
    coordinator.dispose()
    dialogs.dispose()
    parent.destroy()
    protocol.unhandle('dsh-app')
  }

  async function show(name, options, confirm, expected) {
    const created = once(app, 'web-contents-created', { signal: AbortSignal.timeout(10_000) })
    const pending = dialogs.show(parent, options)
    const [, contents] = await created
    await once(contents, 'did-finish-load', { signal: AbortSignal.timeout(10_000) })
    const view = await contents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { observer.disconnect(); reject(new Error('Dialog did not render')); }, 10000);
      const observer = new MutationObserver(check);
      function check() {
        if (!document.body.classList.contains('visible')) return;
        observer.disconnect(); clearTimeout(deadline);
        const card = document.querySelector('main').getBoundingClientRect();
        const actions = document.getElementById('actions').getBoundingClientRect();
        resolve({ message: document.getElementById('title').textContent,
          detail: document.getElementById('detail').textContent,
          buttons: [...document.querySelectorAll('#actions button')].map(button => button.textContent),
          fits: card.left >= 0 && card.right <= innerWidth && card.top >= 0 && card.bottom <= innerHeight
            && actions.left >= card.left && actions.right <= card.right,
          focused: document.activeElement.id, isolated: typeof window.require === 'undefined' });
      }
      observer.observe(document.body, { attributes: true, subtree: true }); check();
    })`)
    if (expected) assert.deepEqual({ message: view.message, detail: view.detail, buttons: view.buttons },
      { message: expected.message, detail: expected.detail, buttons: expected.buttons })
    assert.equal(view.fits, true)
    assert.equal(view.focused, 'dialog')
    assert.equal(view.isolated, true)
    await contents.executeJavaScript('Promise.all(document.getAnimations().map(animation => animation.finished))')
    await writeFile(join(root, `${name}.png`), (await contents.capturePage()).toPNG())
    const closed = once(contents, 'destroyed', { signal: AbortSignal.timeout(10_000) })
    if (confirm) await contents.executeJavaScript("setTimeout(() => document.querySelector('.primary').click(), 0); undefined")
    else contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    assert.equal((await pending).response, confirm ? 0 : options.cancelId ?? 0)
    await closed
    results.push({ name, ...view })
  }
}
void main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
