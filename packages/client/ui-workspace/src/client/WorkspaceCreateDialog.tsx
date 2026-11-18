/** Named workspace draft; choosing folders never registers them before Create. */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspacePickFlowProps } from './WorkspacePicker.tsx'
import type { DirectoryFlowOwnerProps } from './contract/slots.ts'
import css from './WorkspacePicker.module.css'

/** Creation dialog dependencies supplied by the workspace flow owner. */
interface Props extends Pick<WorkspacePickFlowProps, 't' | 'createWorkspace' | 'renderDirectoryFlow' | 'onPick'> {
  readonly onClose: () => void
  readonly pickerAvailable: boolean
}

/**
 * Stage a name and ordered folders, preserving the draft after picker cancellation or save failure.
 * @param props - creation action, directory picker, copy, and completion callbacks.
 * @returns the creation dialog and its directory chooser.
 */
export function WorkspaceCreateDialog({ t, createWorkspace, renderDirectoryFlow, onPick, onClose, pickerAvailable }: Props): ReactNode {
  const [title, setTitle] = useState('')
  const [folders, setFolders] = useState<readonly string[]>([])
  const [primary, setPrimary] = useState('')
  const [picking, setPicking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  const chooser = useRef(0)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; chooser.current += 1 }
  }, [])
  useEffect(() => {
    if (!pickerAvailable) { chooser.current += 1; setPicking(false) }
  }, [pickerAvailable])
  const close = (): void => { if (!saving) onClose() }
  const pick = (): void => { setError(null); chooser.current += 1; setPicking(true) }
  const generation = chooser.current
  const owner: DirectoryFlowOwnerProps = {
    open: picking,
    busy: false,
    onPicked: (path) => {
      if (!picking || generation !== chooser.current || !alive.current) return
      chooser.current += 1
      setPicking(false)
      setFolders(current => current.includes(path) ? current : [...current, path])
      setPrimary(current => current || path)
      setTitle(current => current || path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || path)
    },
    onCancel: () => { if (generation !== chooser.current) return; chooser.current += 1; setPicking(false) },
    onError: (message) => { if (generation !== chooser.current) return; chooser.current += 1; setPicking(false); setError(message) },
  }
  const create = (): void => {
    if (saving || title.trim() === '' || primary === '') return
    setSaving(true)
    setError(null)
    void createWorkspace({ path: primary, title: title.trim(), additionalPaths: folders.filter(path => path !== primary) })
      .then((workspace) => { if (alive.current) onPick(workspace.workspaceId) })
      .catch((reason: unknown) => { if (alive.current) setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { if (alive.current) setSaving(false) })
  }
  return <>
    <Modal open={!picking} onClose={close} title={t('create.title')} closeLabel={t('close')} className={css.createDialog ?? ''} contentClassName={css.createContent ?? ''}
      footer={<>
        <Button variant="outline" disabled={saving} onClick={close}>{t('cancel')}</Button>
        <Button variant="primary" disabled={saving || title.trim() === '' || folders.length === 0} onClick={create}>
          {t(saving ? 'create.pending' : 'create.submit')}
        </Button>
      </>}>
      <div className={css.createForm}>
        <label className={css.field}>{t('field.workspaceName')}
          <input className={css.nameInput} data-modal-autofocus value={title} disabled={saving}
            onChange={event => { setTitle(event.target.value) }} />
        </label>
        <div className={css.folderHeading}>
          <span>{t('create.folders')}</span>
          <Button variant="outline" disabled={saving || !pickerAvailable} onClick={pick}>{t('create.addFolder')}</Button>
        </div>
        <p className={css.hint}>{t('create.primaryHint')}</p>
        <div className={css.folders}>
          {folders.length === 0 && <p className={css.hint}>{t('create.empty')}</p>}
          {folders.map(path => <div key={path} className={css.folderRow}>
            <label className={css.folderChoice}>
              <input type="radio" name="workspace-primary" checked={path === primary} disabled={saving}
                aria-label={t('create.primary', { path })} onChange={() => { setPrimary(path) }} />
              <span className={css.folderPath}>{path}</span>
            </label>
            <Button variant="ghost" size="sm" disabled={saving} aria-label={t('create.removeFolder', { path })} onClick={() => {
              const next = folders.filter(folder => folder !== path)
              setFolders(next)
              if (primary === path) setPrimary(next[0] ?? '')
            }}>{t('create.remove')}</Button>
          </div>)}
        </div>
        {error !== null && <div role="alert" className={css.modalError}>{error}</div>}
      </div>
    </Modal>
    {renderDirectoryFlow(owner)}
  </>
}
