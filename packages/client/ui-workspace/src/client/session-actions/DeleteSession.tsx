/** Permanent Session deletion confirmation, independent of its source menu. */
import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionDeleteProps, SessionDeleteRequest } from '../contract/slots.ts'
import css from '../rows/WorkspaceBrowser.module.css'

/** @param props - captured request and shared deletion command. @returns the confirmation or nothing. */
export function SessionDeleteDialog({ useDeleteRequest, ...props }: SessionDeleteProps) {
  const request = useDeleteRequest(value => value)
  return request === null ? null : <DeleteForm key={request.sessionId} request={request} {...props} />
}

function DeleteForm({ request, deleteSession, settleSessionDelete, t }: Pick<SessionDeleteProps,
  'deleteSession' | 'settleSessionDelete' | 't'> & { request: SessionDeleteRequest }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = () => { if (!pending) settleSessionDelete() }
  const confirm = async () => {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      await deleteSession(request.sessionId)
      settleSessionDelete()
    } catch (reason) {
      const failure = reason !== null && typeof reason === 'object' && 'rpcError' in reason
        ? reason.rpcError : undefined
      const active = failure !== null && typeof failure === 'object' && 'code' in failure
        && failure.code === 'workspace/session-active'
      setError(t(active ? 'delete.session.active' : 'delete.session.failed'))
      setPending(false)
    }
  }
  return <Modal open onClose={close} closeLabel={t('close')} title={t('delete.session')}
    description={t('delete.session.desc', { title: request.displayTitle || t('session.untitled') })}
    footer={<>
      <Button variant="outline" disabled={pending} onClick={close} data-modal-autofocus>{t('cancel')}</Button>
      <Button variant="outline" className={css.deleteAction} disabled={pending} onClick={() => { void confirm() }}>{t('delete.session')}</Button>
    </>}>
    {pending && <div className={css.deleteStatus} role="status">{t('delete.pending')}</div>}
    {error !== null && <div className={css.renameError} role="alert">{error}</div>}
  </Modal>
}
