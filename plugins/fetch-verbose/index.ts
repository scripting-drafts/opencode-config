import { appendFile, chmod, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Plugin } from "@opencode/plugin"

/**
 * Sanitized fetch diagnostics for model requests.
 *
 * OpenCode ships as a compiled Bun binary, so there is no per-fetch
 * `verbose: true` option to enable. This hook records the same useful
 * request/response metadata, but redacts credentials instead of printing
 * raw Authorization headers.
 *
 * Disable by moving this folder out of ~/.config/opencode/plugins/
 * (everything under that directory is auto-discovered, regardless of name).
 */
const LOG =
  process.env.OPENCODE_FETCH_LOG ??
  join(homedir(), ".local", "share", "opencode", "log", "fetch-verbose.jsonl")

const SENSITIVE = /authorization|api[-_]?key|cookie|token|secret|password|private/i

const redactHeaders = (headers: Headers) => {
  const out: Record<string, string> = {}
  for (const [key, value] of headers) out[key] = SENSITIVE.test(key) ? "[REDACTED]" : value
  return out
}

const redactUrl = (input: string) => {
  try {
    const url = new URL(input)
    url.username = ""
    url.password = ""
    for (const key of url.searchParams.keys()) {
      if (SENSITIVE.test(key)) url.searchParams.set(key, "[REDACTED]")
    }
    return url.toString()
  } catch {
    return input
  }
}

const truncate = (value: string, limit = 500) => (value.length > limit ? `${value.slice(0, limit)}…` : value)

const errorInfo = (error: unknown) => {
  if (error instanceof Error) {
    const cause = error.cause
    return {
      name: error.name,
      message: truncate(error.message),
      code: (error as Error & { code?: string }).code,
      cause:
        cause instanceof Error
          ? {
              name: cause.name,
              message: truncate(cause.message),
              code: (cause as Error & { code?: string }).code,
            }
          : undefined,
    }
  }
  if (error && typeof error === "object") {
    const value = error as {
      type?: string
      message?: string
      status?: number
      retryAfterMs?: number
      cause?: unknown
    }
    return {
      type: value.type,
      message: typeof value.message === "string" ? truncate(value.message) : undefined,
      status: value.status,
      retryAfterMs: value.retryAfterMs,
      cause: value.cause ? errorInfo(value.cause) : undefined,
    }
  }
  return { value: String(error) }
}

const safe = (value: unknown) => {
  const seen = new WeakSet<object>()
  const text = JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") return item.toString()
    if (typeof item === "object" && item !== null) {
      if (seen.has(item)) return "[Circular]"
      seen.add(item)
    }
    return item
  })
  return text.length > 4096 ? `${text.slice(0, 4096)}…` : text
}

export default Plugin.define({
  id: "fetch-verbose",
  async setup(ctx) {
    const write = async (entry: unknown) => {
      await mkdir(dirname(LOG), { recursive: true })
      await appendFile(LOG, `${safe(entry)}\n`, { mode: 0o600 })
      await chmod(LOG, 0o600).catch(() => {})
    }

    const observe = (response: Response, url: string) => {
      if (!response.body) return response
      const reader = response.body.getReader()
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read()
            if (done) return controller.close()
            controller.enqueue(value)
          } catch (error) {
            await write({
              ts: new Date().toISOString(),
              type: "response-error",
              url: redactUrl(url),
              error: errorInfo(error),
            })
            controller.error(error)
          }
        },
        async cancel(reason) {
          await reader.cancel(reason)
        },
      })
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    }

    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (!/(failed|error)/i.test(event.type)) continue
        const data = "data" in event && event.data && typeof event.data === "object" ? event.data : undefined
        await write({
          ts: new Date().toISOString(),
          type: "event",
          event: event.type,
          sessionID: data && "sessionID" in data ? data.sessionID : undefined,
          error: data && "error" in data ? errorInfo(data.error) : undefined,
        })
      }
    })()

    const registrations = await Promise.all([
      ctx.session.hook("http.request", async (evt) => {
        await write({
          ts: new Date().toISOString(),
          type: "request",
          sessionID: evt.sessionID,
          model: evt.model,
          method: evt.request.method,
          url: redactUrl(evt.request.url),
          headers: redactHeaders(evt.request.headers),
        })
      }),
      ctx.session.hook("http.response", async (evt) => {
        await write({
          ts: new Date().toISOString(),
          type: "response",
          sessionID: evt.sessionID,
          model: evt.model,
          url: redactUrl(evt.request.url),
          status: evt.response.status,
          headers: redactHeaders(evt.response.headers),
        })
        evt.response = observe(evt.response, evt.request.url)
      }),
      ctx.session.hook("retry", async (evt) => {
        await write({
          ts: new Date().toISOString(),
          type: "retry",
          sessionID: evt.sessionID,
          model: evt.model,
          attempt: evt.attempt,
          error: errorInfo(evt.error),
        })
      }),
    ])

    return async () => {
      controller.abort()
      await Promise.all(registrations.map((registration) => registration.dispose()))
    }
  },
})
