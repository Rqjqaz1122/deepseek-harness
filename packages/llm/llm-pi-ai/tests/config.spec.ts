import { describe, expect, it } from 'vitest'
import { assertServiceable, Config, DEFAULT_CLIENT_VERSION, resolveProfiles, type Options } from '../src/config.ts'

describe('Anthropic client compatibility configuration', () => {
  const route = { api: 'anthropic-messages', baseURL: 'https://gateway.test', models: [{ id: 'm' }] }

  it('defaults to API and applies client headers only when explicitly enabled', () => {
    const profile = { ...route, headers: { 'X-App': 'api' }, clientHeaders: { 'x-app': 'client', 'X-Client-Version': 'example-version' } }
    const standard = resolveProfiles({ gateway: profile }).get('gateway')!
    expect(standard.requestMode).toBe('api')
    expect(standard.clientVersion).toBe(DEFAULT_CLIENT_VERSION)
    expect(standard.inferenceHeaders).toEqual({ 'x-app': 'api' })
    const client = resolveProfiles({ gateway: { ...profile, requestMode: 'client-compat' } }).get('gateway')!
    expect(client.inferenceHeaders).toEqual({ 'x-app': 'client', 'x-client-version': 'example-version' })
    expect(client.headers).toEqual({ 'X-App': 'api' })
  })

  it('provides client defaults without requiring additional headers and accepts an explicit version', () => {
    const client = resolveProfiles({ gateway: { ...route, requestMode: 'client-compat', clientVersion: '2.1.323' } }).get('gateway')!
    expect(client.clientVersion).toBe('2.1.323')
    expect(client.inferenceHeaders).toEqual({ 'x-app': 'cli' })
  })

  it('rejects incompatible protocols, invalid versions and malformed headers before dispatch', () => {
    expect(() => resolveProfiles({ gateway: { ...route, clientVersion: 'latest' } })).toThrow(/clientVersion must use major.minor.patch/)
    expect(() => resolveProfiles({ gateway: { ...route, api: 'openai-completions', requestMode: 'client-compat', clientHeaders: { 'x-app': 'client' } } })).toThrow(/requires Anthropic Messages/)
    expect(() => resolveProfiles({ gateway: { ...route, clientHeaders: { 'invalid name': 'value' } } })).toThrow(/not valid for Fetch/)
    expect(() => resolveProfiles({ gateway: { ...route, clientHeaders: { 'x-app': 'value\nnext' } } })).toThrow(/not valid for Fetch/)
    expect(routeWith({ requestMode: 'native' })).toThrow()
  })

  it.each(['Authorization', 'Proxy-Authorization', 'X-API-Key', 'Cookie', 'Set-Cookie', 'User-Agent'])(
    'rejects %s in non-secret client headers', (name) => {
      expect(() => resolveProfiles({ gateway: { ...route, clientHeaders: { [name]: 'value' } } })).toThrow(/cannot/)
    },
  )
})

/** Validate one hand-declared route, with the caller's fields layered onto it. */
const routeWith = (profile: Record<string, unknown>): (() => unknown) =>
  () => ({ providers: Config({
    providers: {
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        models: [{ id: 'm' }],
        ...profile,
      },
    },
  }).providers.get() })

/** Validate that route with the caller's fields on its single model entry. */
const configWith = (model: Record<string, unknown>): (() => unknown) =>
  routeWith({ models: [{ id: 'm', ...model }] })

describe('reasoning schema boundary', () => {
  it('accepts an empty provider section and propagates unexpected catalog failures', () => {
    expect(() => { assertServiceable({}) }).not.toThrow()
    const failure = new TypeError('model metadata lookup failed')
    expect(() => resolveProfiles({ openrouter: { models: [{
      id: '111',
      get name(): string { throw failure },
    }], api: 'openai-completions' } }, 'deferred')).toThrow(failure)
  })

  it('rejects a level pi-ai does not know at the write that produced it', () => {
    expect(configWith({ reasoningEfforts: { ultra: 'x' } })).toThrow(/"off"/)
    expect(configWith({ reasoningEfforts: { high: 42 } })).toThrow()
  })

  it('keeps false distinguishable from an absent declaration', () => {
    type Materialized = { providers: Record<string, { models?: { reasoningEfforts?: unknown }[] }> }
    const withFalse = configWith({ reasoningEfforts: false })() as Materialized
    expect(withFalse.providers['acme-gateway']?.models?.[0]?.reasoningEfforts).toBe(false)
    const absent = configWith({})() as Materialized
    expect(absent.providers['acme-gateway']?.models?.[0]?.reasoningEfforts).toBeUndefined()
  })

  it('rejects a thinking format outside the offered set', () => {
    expect(configWith({ compat: { thinkingFormat: 'quantum' } })).toThrow(/expected/)
  })

  it('accepts Baseten template arguments and completion controls', () => {
    expect(configWith({
      compat: {
        supportsFinishReason: false,
        thinkingFormat: 'baseten',
        chatTemplateArgs: { enable_thinking: { $var: 'thinking.enabled' } },
        supportsThinkingTokenBudget: true,
      },
    })).not.toThrow()
  })
})

describe('modality schema boundary', () => {
  it('rejects a modality pi-ai does not know, at either level', () => {
    expect(configWith({ input: ['audio'] })).toThrow(/expected/)
    expect(routeWith({ defaultInput: ['text', 'audio'] })).toThrow(/expected/)
  })

  it('refuses a route whose models could accept nothing', () => {
    // The pair the settings seam runs: the schema accepts the empty list as
    // well-typed, and the namespace validator is what refuses it. Asserting
    // only the schema would report this route as writable.
    expect(routeWith({ defaultInput: [] })).not.toThrow()
    expect(() => { assertServiceable(routeWith({ defaultInput: [] })() as Options) })
      .toThrow(/defaultInput must name at least one modality/)
  })

  type Materialized = {
    providers: Record<string, { defaultInput?: unknown; models?: { input?: unknown }[] }>
  }

  it('materializes an absent entry list as empty and an absent route list as text', () => {
    // The empty-list inheritance rule exists because of exactly this: an entry
    // that declares nothing reaches resolution as `[]`, not as `undefined`.
    const absent = configWith({})() as Materialized
    expect(absent.providers['acme-gateway']?.models?.[0]?.input).toEqual([])
    expect(absent.providers['acme-gateway']?.defaultInput).toEqual(['text'])
  })
})

describe('request image policy bounds', () => {
  it.each([
    ['requestImagePixelBudget', 0, /requestImagePixelBudget must be a positive safe integer/],
    ['requestImagePixelBudget', Number.MAX_SAFE_INTEGER + 1, /requestImagePixelBudget must be a positive safe integer/],
    ['requestImageMaxBytes', 0, /requestImageMaxBytes must be a positive safe integer/],
    ['requestImageMaxBytes', 1.5, /requestImageMaxBytes must be a positive safe integer/],
  ] as const)('rejects %s=%s at service resolution', (field, value, message) => {
    const programmatic = {
      providers: {
        'acme-gateway': {
          api: 'openai-completions',
          baseURL: 'https://acme.test',
          models: [{ id: 'm' }],
          [field]: value,
        },
      },
    } as Options
    expect(() => {
      assertServiceable(programmatic)
    }).toThrow(message)
  })
})
