/**
 * The main process's logger (PLAN §10.1, §15.3).
 *
 * Two rules, both enforced here rather than remembered at call sites:
 *
 *  1. **Transcript content never reaches a log.** Anything that might be user
 *     speech goes through {@link redact}, which reports a length and a hash
 *     prefix instead of the words. Verbose logging is opt-in via
 *     `MURMUR_LOG_TRANSCRIPTS=1` and is documented as a debugging aid only.
 *  2. **Secrets never reach a log.** Sidecar bearer tokens and any
 *     `Authorization` header value are scrubbed from every string we print,
 *     including the ones that arrive inside an error message from `fetch`.
 *
 * Deliberately tiny and dependency-free: it is imported by the sidecar
 * managers, the downloader and the orchestrator, all of which run before
 * anything else is up.
 */

import { createHash } from 'node:crypto'

const TRANSCRIPTS_ALLOWED = process.env['MURMUR_LOG_TRANSCRIPTS'] === '1'

/** Patterns that must never survive into a log line. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi,
  /(authorization["'\s:=]+)[^\s"',}]+/gi,
  /([?&](?:api_?key|token|access_token)=)[^&\s"']+/gi,
]

/**
 * Replace user speech with a non-reversible descriptor.
 *
 * The hash prefix is enough to tell "the same transcript came back twice" apart
 * from "two different transcripts" while debugging, without storing the words.
 */
export function redact(text: string | null | undefined): string {
  if (text === null || text === undefined) return '<none>'
  if (TRANSCRIPTS_ALLOWED) return JSON.stringify(text)
  if (text.length === 0) return '<empty>'
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 8)
  return `<${text.length} chars, sha256:${digest}>`
}

/** Strip anything secret-shaped from an arbitrary string. */
export function scrubSecrets(value: string): string {
  let out = value
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (_match, prefix: string) => `${prefix}<redacted>`)
  }
  return out
}

function format(value: unknown): unknown {
  if (typeof value === 'string') return scrubSecrets(value)
  if (value instanceof Error) return scrubSecrets(`${value.name}: ${value.message}`)
  return value
}

export interface Logger {
  debug(message: string, ...rest: unknown[]): void
  info(message: string, ...rest: unknown[]): void
  warn(message: string, ...rest: unknown[]): void
  error(message: string, ...rest: unknown[]): void
  /** A sub-logger with an extra tag, e.g. `createLogger('stt').child('whisper')`. */
  child(tag: string): Logger
}

const DEBUG_ENABLED = process.env['MURMUR_DEBUG'] === '1'

/**
 * @param tag Short subsystem name; shows up as `[murmur:tag]`.
 */
export function createLogger(tag: string): Logger {
  const prefix = `[murmur:${tag}]`
  return {
    debug(message, ...rest) {
      if (DEBUG_ENABLED) console.debug(prefix, scrubSecrets(message), ...rest.map(format))
    },
    info(message, ...rest) {
      console.log(prefix, scrubSecrets(message), ...rest.map(format))
    },
    warn(message, ...rest) {
      console.warn(prefix, scrubSecrets(message), ...rest.map(format))
    },
    error(message, ...rest) {
      console.error(prefix, scrubSecrets(message), ...rest.map(format))
    },
    child(childTag) {
      return createLogger(`${tag}:${childTag}`)
    },
  }
}

/** A logger that drops everything — the default in unit tests. */
export function createNullLogger(): Logger {
  const noop = (): void => undefined
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  }
  return logger
}
