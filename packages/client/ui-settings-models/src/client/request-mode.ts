/** Parsing of non-secret Anthropic client header drafts. @module */
import type { ModelsKey } from './locales.ts'

/**
 * Validate the JSON object edited in the client-compatibility form.
 * @param text - JSON mapping header names to string values.
 * @returns Parsed headers when valid JSON, and a localized failure key when unusable.
 */
export function parseClientHeaders(text: string): { headers?: Record<string, string>; failure?: ModelsKey } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (_error) {
    // Parser details can contain header values; show only the localized correction.
    return { failure: 'clientHeadersInvalidJson' }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { failure: 'clientHeadersInvalidJson' }
  const entries = Object.entries(value)
  const headers: [string, string][] = []
  for (const [name, content] of entries) {
    if (typeof content !== 'string') return { failure: 'clientHeadersInvalidJson' }
    if (name.toLowerCase() === 'user-agent') return { failure: 'clientHeadersReserved' }
    if (['authorization', 'proxy-authorization', 'x-api-key', 'cookie', 'set-cookie'].includes(name.toLowerCase())) {
      return { failure: 'clientHeadersCredentials' }
    }
    try {
      new Headers([[name, content]])
    } catch (_error) {
      // Fetch diagnostics can include values; the field identifies the failed draft.
      return { failure: 'clientHeadersInvalidField' }
    }
    headers.push([name, content])
  }
  return { headers: Object.fromEntries(headers) }
}
