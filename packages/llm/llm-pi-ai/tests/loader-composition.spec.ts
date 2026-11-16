/** Profile patch edits and credential updates reach the next real adapter request. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { createMessage, createUserMessage, userAgent } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { profileComposition } from '../../../settings/settings/tests/profile-composition.ts'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { recordKeyFor } from '../src/auth.ts'
import { assemble } from './assemble.ts'
import { anthropicTextEvents, closeMockServers, mockServer, textEvents } from './mock-server.ts'
import { DEFAULT_CLIENT_VERSION } from '../src/config.ts'

/** One text block, then a tool call truncated by the output-token ceiling. */
const truncatedToolCallEvents = [
  '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"content":"partial"},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"echo","arguments":"{\\"text\\":"}}]},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{},"index":0,"finish_reason":"length"}],"usage":{"prompt_tokens":3,"completion_tokens":4}}',
  '[DONE]',
]

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  await closeMockServers()
  vi.unstubAllEnvs()
})

/** Boot the dormant composition: a bare `llm-pi-ai` row with no config at all. */
async function loadComposition(): Promise<{ ctx: Context; settingsPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-pi-composition-'))
  await writeFile(join(root, '.credentials.yaml'), 'version: 1\nrefs:\n  PI_COMPOSITION_KEY: key-from-store\n', { mode: 0o600 })

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: 'test-llm-service'",
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(join(root, '.credentials.yaml'))}`,
    '    debounceMs: 10',
    '- id: authorization',
    "  name: '@deepseek-ai/dsh-authorization'",
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-authorization', AuthorizationService],
    ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2',
    loadCache: new Map(),
    import: (specifier: string) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = internal
  const patchPath = await profileComposition(ctx, root, configPath)
  return { ctx, settingsPath: patchPath }
}

describe('llm-pi-ai real dormant composition', () => {
  it('switches Anthropic inference headers through persisted settings without changing discovery', async () => {
    const server = await mockServer([
      { events: anthropicTextEvents },
      { body: JSON.stringify({ data: [{ id: 'm', display_name: 'Model' }] }) },
      { events: anthropicTextEvents },
    ])
    const { ctx } = await loadComposition()
    await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'gateway'], value: {
      api: 'anthropic-messages', baseURL: server.url, apiKeyEnv: 'PI_COMPOSITION_KEY',
      models: [{ id: 'm' }], headers: { 'X-App': 'standard' },
      requestMode: 'client-compat', clientHeaders: { 'x-app': 'client', 'X-Client-Version': 'example-version' },
    } }])
    const first = await assemble(ctx, { provider: 'gateway', model: 'm', messages: [], sessionId: SessionId('client-session') })
    expect(first.finish).toEqual({ kind: 'stop' })
    expect(first.message.content).toContainEqual({ type: 'text', text: 'hello' })
    expect(server.headers[0]).toMatchObject({
      'x-app': 'client', 'x-client-version': 'example-version',
      'user-agent': `claude-cli/${DEFAULT_CLIENT_VERSION} (external, cli) ${userAgent()}`,
      'x-claude-code-session-id': 'client-session',
    })
    const firstRequest = server.requests[0] as { metadata: { user_id: string } }
    const identity = JSON.parse(firstRequest.metadata.user_id) as { device_id: string; account_uuid: string; session_id: string }
    expect(identity.device_id).toMatch(/^[a-f0-9]{64}$/)
    expect(identity.account_uuid).toBe('')
    expect(identity.session_id).toBe('client-session')
    await expect(ctx.llm.discoverModels('llm-pi-ai', {
      provider: 'gateway', baseURL: server.url, api: 'anthropic-messages',
    })).resolves.toEqual([{ id: 'm', name: 'Model' }])
    expect(server.headers[1]?.['x-app']).toBe('standard')
    expect(server.headers[1]).not.toHaveProperty('x-client-version')
    expect(server.headers[1]?.['user-agent']).toBe(userAgent())
    expect(server.headers[1]).not.toHaveProperty('x-claude-code-session-id')
    await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'gateway', 'requestMode'], value: 'api' }])
    const second = await assemble(ctx, { provider: 'gateway', model: 'm', messages: [] })
    expect(second.finish).toEqual({ kind: 'stop' })
    expect(server.headers[2]?.['x-app']).toBe('standard')
    expect(server.headers[2]).not.toHaveProperty('x-client-version')
    expect(server.headers[2]?.['user-agent']).toBe(userAgent())
    expect(server.headers[2]).not.toHaveProperty('x-claude-code-session-id')
    expect(server.requests[2]).not.toHaveProperty('metadata')
    expect(server.paths).toEqual(['/v1/messages?beta=true', '/v1/models?limit=1000', '/v1/messages?beta=true'])
  })

  it('sends the configured client version without extra headers and enforces it after contributors', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const { ctx } = await loadComposition()
    await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'gateway'], value: {
      api: 'anthropic-messages', baseURL: server.url, apiKeyEnv: 'PI_COMPOSITION_KEY',
      models: [{ id: 'm' }], requestMode: 'client-compat', clientVersion: '2.1.323',
    } }])
    ctx.on('llm-pi-ai/request-headers', (_request, headers, next) => {
      headers.set('user-agent', 'untrusted-version')
      return next()
    })
    const result = await assemble(ctx, { provider: 'gateway', model: 'm', messages: [] })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(server.headers[0]).toMatchObject({
      'x-app': 'cli', 'user-agent': `claude-cli/2.1.323 (external, cli) ${userAgent()}`,
    })
    const clientSessionId = server.headers[0]?.['x-claude-code-session-id']
    expect(clientSessionId).toEqual(expect.stringMatching(/^[a-f0-9-]{36}$/))
    const request = server.requests[0] as { metadata: { user_id: string } }
    expect(JSON.parse(request.metadata.user_id)).toMatchObject({ session_id: clientSessionId })
  })

  it('retains DSH prompts and tools and reuses client identity within one Session', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }, { events: anthropicTextEvents }])
    const { ctx } = await loadComposition()
    await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'gateway'], value: {
      api: 'anthropic-messages', baseURL: server.url, apiKeyEnv: 'PI_COMPOSITION_KEY',
      models: [{ id: 'm' }], requestMode: 'client-compat',
    } }])
    const request = {
      provider: 'gateway', model: 'm', sessionId: SessionId('dsh-session'), system: 'DSH system prompt',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'DSH user message' }], source: { kind: 'user' } })],
      tools: [{ name: 'dsh_echo', description: 'Echo text', parameters: { type: 'object', properties: {} } }],
    }
    await assemble(ctx, request)
    await assemble(ctx, request)
    const body = server.requests[0] as {
      system: { text: string }[]
      messages: { role: string; content: { text: string }[] }[]
      tools: { name: string }[]
    }
    expect(body.system.map(block => block.text)).toEqual(['DSH system prompt'])
    expect(body.messages).toMatchObject([{ role: 'user', content: [{ text: 'DSH user message' }] }])
    expect(body.tools.map(tool => tool.name)).toEqual(['dsh_echo'])
    const bodies = server.requests as { metadata: { user_id: string } }[]
    expect(bodies[0]?.metadata).toEqual(bodies[1]?.metadata)
  })

  it('dispatches header contributors through the Loader-mounted adapter', async () => {
    const server = await mockServer([{ events: textEvents }])
    const { ctx, settingsPath } = await loadComposition()
    ctx.on('llm-pi-ai/request-headers', (request, headers, next) => {
      headers.set('x-request-session', String(request.sessionId))
      return next()
    })
    await writeFile(settingsPath, [
      '- id: llm-pi-ai', '  config:', '    providers:', '      deepseek:',
      '        apiKeyEnv: PI_COMPOSITION_KEY', `        baseURL: ${server.url}`, '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek'])
    }, { timeout: 5000 })
    const result = await assemble(ctx, { model: 'deepseek-flash', messages: [], sessionId: SessionId('loader-session') })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(server.headers[0]?.['x-request-session']).toBe('loader-session')
  })

  it('boots with zero routes and registers one the moment settings supply a profile', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([{ events: textEvents }])
    const { ctx, settingsPath } = await loadComposition()

    // The shipped posture: the adapter exists, no route does.
    expect(ctx.llm.listProviders()).toEqual([])
    const directory = ctx.llm.listConfigurableProviders()
    expect(directory.find(entry => entry.provider === 'azure')).toMatchObject({
      nativeAuth: { env: ['AZURE_OPENAI_API_KEY'], oauth: false },
      baseURLEnv: ['AZURE_OPENAI_BASE_URL', 'AZURE_OPENAI_RESOURCE_NAME'],
    })
    expect(directory.find(entry => entry.provider === 'radius')?.defaultBaseURL).toBe('https://radius.pi.dev/v1')
    expect(directory.find(entry => entry.provider === 'opencode')?.defaultBaseURL).toBeUndefined()

    // Exactly what the web Models page leaves on disk.
    await writeFile(settingsPath, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      deepseek:',
      '        apiKeyEnv: PI_COMPOSITION_KEY',
      `        baseURL: ${server.url}`,
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek'])
    }, { timeout: 5000 })

    const result = await assemble(ctx, { provider: 'deepseek', model: 'deepseek-flash', messages: [] })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.headers[0]?.authorization).toBe('Bearer key-from-store')
  })

  it('offers OpenAI sign-in by API key only, while other subscription logins stay', async () => {
    const { ctx } = await loadComposition()
    const methods = (provider: string): string[] | undefined => ctx.authorization.list()
      .find(entry => entry.key === recordKeyFor(provider))?.methods.map(method => method.id)

    // pi-ai's Sign in with ChatGPT needs an installation ID the harness does
    // not supply, so the route offers only its key login.
    expect(methods('openai')).toEqual(['api-key'])
    expect(methods('anthropic')).toEqual(['oauth', 'api-key'])
  })

  it('uses settings-only route headers for model discovery', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([{ body: JSON.stringify({ data: [{ id: 'acme-private' }] }) }])
    const { ctx, settingsPath } = await loadComposition()

    await writeFile(settingsPath, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      acme-gateway:',
      '        apiKeyEnv: PI_COMPOSITION_KEY',
      '        api: openai-completions',
      `        baseURL: ${server.url}`,
      '        headers:',
      '          X-Company-Code: private-tenant',
      '          Accept: text/plain',
      '          User-Agent: deployment-owned',
      '        models:',
      '          - id: acme-bootstrap',
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['acme-gateway'])
    }, { timeout: 5000 })

    await expect(ctx.llm.discoverModels('llm-pi-ai', {
      provider: 'acme-gateway',
      baseURL: server.url,
      api: 'openai-completions',
    })).resolves.toEqual([{ id: 'acme-private', name: 'acme-private' }])
    expect(server.paths).toEqual(['/models'])
    expect(server.headers[0]?.['x-company-code']).toBe('private-tenant')
    expect(server.headers[0]?.authorization).toBe('Bearer key-from-store')
    expect(server.headers[0]?.accept).toBe('application/json')
    expect(server.headers[0]?.['user-agent']).toBe(userAgent())
  })

  it('continues natively after max-token assembly drops a tool call, with pruned replay metadata', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([
      { events: truncatedToolCallEvents },
      { events: textEvents },
    ])
    const { ctx, settingsPath } = await loadComposition()
    await writeFile(settingsPath, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      deepseek:',
      '        apiKeyEnv: PI_COMPOSITION_KEY',
      `        baseURL: ${server.url}`,
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek'])
    }, { timeout: 5000 })

    const truncated = await assemble(ctx, {
      provider: 'deepseek',
      model: 'deepseek-flash',
      messages: [],
    })
    expect(truncated.finish).toEqual({ kind: 'max-tokens' })
    expect(truncated.message.content).toEqual([{ type: 'text', text: 'partial' }])
    expect(truncated.message.source).toEqual({
      kind: 'model',
      provider: 'deepseek',
      model: 'deepseek-flash',
      replayState: {
        response: {
          kind: 'pi-ai',
          version: 2,
          api: 'openai-completions',
          provider: 'deepseek',
          model: 'deepseek-flash',
          stopReason: 'length',
        },
        blocks: [{ type: 'text' }],
      },
    })

    const continued = await assemble(ctx, {
      provider: 'deepseek',
      model: 'deepseek-flash',
      messages: [
        truncated.message,
        createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }),
      ],
    })
    expect(continued.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.requests).toHaveLength(2)
    expect(server.requests[1]).toMatchObject({
      messages: [
        { role: 'assistant', content: 'partial' },
        { role: 'user', content: 'continue' },
      ],
    })
    const followup = server.requests[1] as { messages?: unknown[] }
    expect(followup.messages?.[0]).not.toHaveProperty('tool_calls')
  })

  it('continues a legacy session whose stored replay state no longer matches its content', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([{ events: textEvents }])
    const { ctx, settingsPath } = await loadComposition()
    await writeFile(settingsPath, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      deepseek:',
      '        apiKeyEnv: PI_COMPOSITION_KEY',
      `        baseURL: ${server.url}`,
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek'])
    }, { timeout: 5000 })

    // A pre-envelope session log entry: max-token assembly dropped the tool
    // call from content while the flat v1 state still describes both blocks.
    const poisoned = createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'partial' }],
      source: {
        kind: 'model',
        ...{
          provider: 'deepseek',
          model: 'deepseek-flash',
          replayState: {
            kind: 'pi-ai',
            version: 1,
            api: 'openai-completions',
            provider: 'deepseek',
            model: 'deepseek-flash',
            stopReason: 'length',
            blocks: [{ type: 'text' }, { type: 'tool-call' }],
          },
        },
      },
    })
    const continued = await assemble(ctx, {
      provider: 'deepseek',
      model: 'deepseek-flash',
      messages: [
        poisoned,
        createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }),
      ],
    })
    expect(continued.finish).toEqual({ kind: 'stop' })
    expect(continued.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.requests[0]).toMatchObject({
      messages: [
        { role: 'assistant', content: 'partial' },
        { role: 'user', content: 'continue' },
      ],
    })
  })
})
