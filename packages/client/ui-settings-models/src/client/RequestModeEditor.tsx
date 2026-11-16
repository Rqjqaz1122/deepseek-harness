/** Anthropic inference mode and explicit client compatibility headers. @module */
import { useId, type ReactNode } from 'react'
import type { ModelsKey } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Props for the provider-owned request mode draft. */
interface RequestModeEditorProps {
  mode: 'api' | 'client-compat'
  headers: string
  failure: ModelsKey | undefined
  disabled: boolean
  t: (key: ModelsKey) => string
  onModeChange: (mode: 'api' | 'client-compat') => void
  onHeadersChange: (text: string) => void
}

/**
 * Render request format choices without starting a native client.
 * @param props - draft, validation and provider editing callbacks.
 * @returns the mode field and active compatibility header editor.
 */
export function RequestModeEditor(props: RequestModeEditorProps): ReactNode {
  const { mode, headers, failure, disabled, t, onModeChange, onHeadersChange } = props
  const headersId = useId()
  return <>
    <div className={styles['field']}>
      <span className={styles['fieldLabel']}>{t('requestMode')}</span>
      <select
        className={`${styles['input']} ${styles['selectInput']}`}
        aria-label={t('requestMode')}
        value={mode}
        disabled={disabled}
        onChange={(event) => { onModeChange(event.target.value === 'client-compat' ? 'client-compat' : 'api') }}
      >
        <option value="api">{t('requestModeApi')}</option>
        <option value="client-compat">{t('requestModeClient')}</option>
      </select>
      <p className={styles['advancedHint']}>{t(mode === 'api' ? 'requestModeApiHint' : 'requestModeClientHint')}</p>
    </div>
    {mode === 'api' ? null : <div className={styles['field']}>
      <span className={styles['fieldLabel']}>{t('clientHeaders')}</span>
      <textarea
        className={`${styles['input']} ${styles['clientHeaders']}`}
        aria-label={t('clientHeaders')}
        aria-invalid={failure !== undefined}
        aria-describedby={`${headersId}-hint${failure === undefined ? '' : ` ${headersId}-error`}`}
        rows={5}
        spellCheck={false}
        value={headers}
        disabled={disabled}
        onChange={(event) => { onHeadersChange(event.target.value) }}
      />
      <p id={`${headersId}-hint`} className={styles['advancedHint']}>{t('clientHeadersHint')}</p>
      {failure === undefined ? null : <p id={`${headersId}-error`} role="alert" className={styles['error']}>{t(failure)}</p>}
    </div>}
  </>
}
