/** Rate limits, overload and temporary server or gateway errors (Cloudflare's 520 to 524). */
const RETRYABLE = new Set([429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529])

export type PostOptions = {
  apiKey: string
  /** How the service is named in errors. */
  service: string
  retries: number
  timeoutMs: number
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
}

/** A request the service answered with an error status. */
export class HttpError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

/** POSTs JSON with a bearer key, retrying with exponential backoff when the service is busy. */
export async function postJson<T>(url: string, body: unknown, options: PostOptions): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await options.fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs),
    })
    if (res.ok) return (await res.json()) as T
    if (RETRYABLE.has(res.status) && attempt < options.retries) {
      await options.sleep(500 * 2 ** attempt)
      continue
    }
    // The body explains validation errors; it never contains the key.
    throw new HttpError(`${options.service} request failed with ${res.status}: ${oneLine(await res.text())}`, res.status)
  }
}

/**
 * The API key from an option or the environment. A line break or other stray
 * character would otherwise end up quoted in a request error, and so in a trace.
 */
export function apiKey(value: string | undefined, variable: string, provider: string, hint = ''): string {
  const key = value?.trim()
  if (!key) throw new Error(`Set ${variable} in .env.jevvium or your shell to use the ${provider} provider.${hint ? ` ${hint}` : ''}`)
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\x7f]/.test(key)) throw new Error(`${variable} contains a space, line break or control character; check the file it comes from`)
  return key
}

/** An error body on one line, without an HTML error page's markup. */
function oneLine(body: string): string {
  const text = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length > 300 ? `${text.slice(0, 300)}...` : text
}
