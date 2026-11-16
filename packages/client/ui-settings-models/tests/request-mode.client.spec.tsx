// @vitest-environment jsdom
/** Anthropic request mode drafts survive switching and persist through both forms. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ProviderEditor } from '../src/client/ProviderEditor.tsx'
import { CustomProviderCard } from '../src/client/CustomProviderCard.tsx'
import type { ModelsOperations } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'
import { parseClientHeaders } from '../src/client/request-mode.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)
const t = (key: keyof typeof en): string => en[key]

function fixture(profile: Record<string, JsonValue> = {}) {
  const schema = Schema.object({ providers: Schema.dict(Schema.object({
    api: Schema.union(['anthropic-messages', 'openai-completions']),
    baseURL: Schema.string(),
    requestMode: Schema.union(['api', 'client-compat']),
    clientHeaders: Schema.dict(Schema.string()),
    models: Schema.array(Schema.object({ id: Schema.string() })),
  })) })
  const value = { providers: { anthropic: profile } }
  const namespace: SettingsNamespaceView = {
    ns: 'llm-pi-ai', schema: JSON.parse(JSON.stringify(schema.toJSON())) as JsonValue,
    base: {}, value, user: value, revision: 1, secrets: [], autoGenerate: true, applies: 'live',
  }
  const writeSettings = vi.fn<ModelsOperations['writeSettings']>(async () => ({ kind: 'written', view: namespace }))
  const operations: ModelsOperations = {
    writeSettings,
    storeCredential: vi.fn(async () => undefined),
    removeCredential: vi.fn(async () => undefined),
    discoverModels: vi.fn<ModelsOperations['discoverModels']>(async () => ({ kind: 'found', models: [] })),
  }
  return { namespace, operations, writeSettings }
}

it.each([
  ['{', 'clientHeadersInvalidJson'], ['[]', 'clientHeadersInvalidJson'], ['null', 'clientHeadersInvalidJson'],
  ['{"x-app":42}', 'clientHeadersInvalidJson'],
  ['{"invalid name":"v"}', 'clientHeadersInvalidField'], ['{"x-app":"a\\nb"}', 'clientHeadersInvalidField'],
  ['{"Authorization":"secret"}', 'clientHeadersCredentials'], ['{"USER-AGENT":"client"}', 'clientHeadersReserved'],
] as const)('explains unusable header draft %s without echoing its values', (text, failure) => {
  expect(parseClientHeaders(text).failure).toBe(failure)
})

it('persists an Anthropic client mode, retains its draft when toggled and gates invalid input', async () => {
  const { namespace, operations, writeSettings } = fixture({ headers: { 'x-tenant': 'keep' } })
  render(<ProviderEditor provider="anthropic" displayName="Anthropic" namespace={namespace}
    schema={settingsSchema} settingsPath={['providers', 'anthropic']} operations={operations}
    t={t} readOnly={false} onClose={vi.fn()} />)
  expect(screen.getByLabelText<HTMLSelectElement>(en.requestMode).value).toBe('api')
  fireEvent.change(screen.getByLabelText(en.requestMode), { target: { value: 'client-compat' } })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.apply }).disabled).toBe(false)
  fireEvent.change(screen.getByLabelText(en.clientHeaders), { target: { value: '{' } })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.apply }).disabled).toBe(true)
  expect(screen.getByRole('alert').textContent).toBe(en.clientHeadersInvalidJson)
  const text = '{"X-Client-Version":"example-version"}'
  fireEvent.change(screen.getByLabelText(en.clientHeaders), { target: { value: text } })
  fireEvent.change(screen.getByLabelText(en.requestMode), { target: { value: 'api' } })
  expect(screen.queryByLabelText(en.clientHeaders)).toBeNull()
  fireEvent.change(screen.getByLabelText(en.requestMode), { target: { value: 'client-compat' } })
  expect(screen.getByLabelText<HTMLTextAreaElement>(en.clientHeaders).value).toBe(text)
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await waitFor(() => { expect(writeSettings).toHaveBeenCalledOnce() })
  expect(writeSettings.mock.calls[0]?.[1]).toEqual([
    { op: 'set', path: ['providers', 'anthropic', 'requestMode'], value: 'client-compat' },
    { op: 'set', path: ['providers', 'anthropic', 'clientHeaders', 'X-Client-Version'], value: 'example-version' },
  ])
})

it('reopens saved headers, permits standard mode and disables edits on read-only settings', () => {
  const { namespace, operations } = fixture({ requestMode: 'client-compat', clientHeaders: { 'x-app': 'client' } })
  const props = { provider: 'anthropic', displayName: 'Anthropic', namespace, schema: settingsSchema,
    settingsPath: ['providers', 'anthropic'], operations, t, readOnly: true, onClose: vi.fn() }
  const view = render(<ProviderEditor {...props} />)
  expect(screen.getByLabelText<HTMLSelectElement>(en.requestMode).disabled).toBe(true)
  expect(screen.getByLabelText<HTMLTextAreaElement>(en.clientHeaders).value).toContain('client')
  view.rerender(<ProviderEditor {...props} readOnly={false} />)
  fireEvent.change(screen.getByLabelText(en.requestMode), { target: { value: 'api' } })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.apply }).disabled).toBe(false)
})

it('creates a custom Anthropic provider with explicit client headers', async () => {
  const { operations, writeSettings } = fixture()
  render(<CustomProviderCard taken={[]} protocols={['anthropic-messages', 'openai-completions']}
    reasoningLevels={[]} revision={1} operations={operations} t={t} readOnly={false} onClose={vi.fn()} />)
  fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'gateway' } })
  fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://gateway.test' } })
  fireEvent.click(screen.getByRole('button', { name: en.addModel }))
  fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'm' } })
  fireEvent.change(screen.getByLabelText(en.requestMode), { target: { value: 'client-compat' } })
  fireEvent.change(screen.getByLabelText(en.clientHeaders), { target: { value: '{"x-app":"client"}' } })
  fireEvent.click(screen.getByRole('button', { name: en.create }))
  await waitFor(() => { expect(writeSettings).toHaveBeenCalledOnce() })
  expect(writeSettings.mock.calls[0]?.[1][0]).toMatchObject({
    op: 'set', path: ['providers', 'gateway'], value: {
      api: 'anthropic-messages', requestMode: 'client-compat', clientHeaders: { 'x-app': 'client' },
    },
  })
})

it('restores API mode when an edited provider changes to another protocol', async () => {
  const { namespace, operations, writeSettings } = fixture({
    api: 'anthropic-messages', requestMode: 'client-compat', clientHeaders: { 'x-app': 'client' }, models: [{ id: 'm' }],
  })
  render(<ProviderEditor provider="anthropic" displayName="Anthropic" namespace={namespace}
    declared schema={settingsSchema} settingsPath={['providers', 'anthropic']} operations={operations}
    t={t} readOnly={false} onClose={vi.fn()} />)
  fireEvent.click(screen.getByText(en.customized))
  fireEvent.change(screen.getByLabelText(en.customApi), { target: { value: 'openai-completions' } })
  expect(screen.queryByLabelText(en.requestMode)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await waitFor(() => { expect(writeSettings).toHaveBeenCalledOnce() })
  expect(writeSettings.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
    { op: 'set', path: ['providers', 'anthropic', 'requestMode'], value: 'api' },
  ]))
})

it('accepts an empty additional-header object for the automatic client preset', () => {
  expect(parseClientHeaders('{}')).toEqual({ headers: {} })
})
