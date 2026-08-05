/**
 * The **only** way Murmur reaches the network (PLAN §10.2, §15.3).
 *
 * Everything that could ever leave the machine funnels through
 * {@link allowlistedFetch}, which refuses any host that is not on the Hugging
 * Face allowlist. There is no escape hatch and no configuration knob: a
 * reviewer can grep for `fetch(` in `src/main`, find only this file, and be
 * done. The loopback sidecar clients do *not* use it — they talk to
 * `127.0.0.1` and are covered by {@link loopbackFetch}, which is equally strict
 * in the other direction (loopback only, never the internet).
 *
 * Redirects are followed manually so every hop is re-checked; `fetch`'s own
 * `redirect: 'follow'` would let hop #2 land anywhere. Hugging Face always
 * redirects model files to its CDN, so this path is exercised on every
 * download.
 */

import { scrubSecrets } from '../logging'

/**
 * Hosts model downloads may touch. Exact matches plus the CDN wildcards HF
 * actually serves LFS objects from — verified against live redirects.
 */
const ALLOWED_HOSTS: readonly string[] = Object.freeze([
  'huggingface.co',
  'cdn-lfs.huggingface.co',
  'cdn-lfs.hf.co',
  'cdn-lfs-us-1.hf.co',
  'cas-bridge.xethub.hf.co',
  'cas-server.xethub.hf.co',
  'transfer.xethub.hf.co',
])

/** Suffixes that stand in for a wildcard, e.g. `us.aws.cdn.hf.co`. */
const ALLOWED_HOST_SUFFIXES: readonly string[] = Object.freeze([
  '.cdn.hf.co',
  '.cdn-lfs.hf.co',
  '.xethub.hf.co',
])

/** Maximum redirect hops before we give up. */
const MAX_REDIRECTS = 5

export class BlockedHostError extends Error {
  override readonly name = 'BlockedHostError'
  readonly host: string
  readonly url: string

  constructor(url: string, host: string) {
    super(
      `Refused to contact "${host}" — Murmur only talks to Hugging Face download hosts ` +
        `(PLAN §10.2). Blocked URL: ${url}`,
    )
    this.host = host
    this.url = url
  }
}

/** Is this host one the app is allowed to reach? Exported for tests. */
export function isAllowedHost(host: string): boolean {
  const normalised = host.toLowerCase()
  if (ALLOWED_HOSTS.includes(normalised)) return true
  return ALLOWED_HOST_SUFFIXES.some((suffix) => normalised.endsWith(suffix))
}

/** The allowlist itself, for the Help panel's "what we contact" disclosure. */
export function allowedHosts(): readonly string[] {
  return [...ALLOWED_HOSTS, ...ALLOWED_HOST_SUFFIXES.map((suffix) => `*${suffix}`)]
}

/**
 * Reject anything that is not `https:` on an allow-listed host.
 *
 * @throws {BlockedHostError} for a disallowed host or a non-https scheme.
 */
export function assertAllowedUrl(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new BlockedHostError(url, '<unparseable>')
  }

  if (parsed.protocol !== 'https:') {
    throw new BlockedHostError(url, `${parsed.hostname} (${parsed.protocol})`)
  }
  if (!isAllowedHost(parsed.hostname)) {
    throw new BlockedHostError(url, parsed.hostname)
  }
  return parsed
}

/** The subset of `fetch` this module needs — injected so tests need no network. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface AllowlistedFetchOptions extends Omit<RequestInit, 'redirect'> {
  /** Overrides `globalThis.fetch`; tests pass a fake. */
  fetchImpl?: FetchLike
  /** Aborts the request (and any redirect hop) when it fires. */
  signal?: AbortSignal
}

/**
 * `fetch`, restricted to the model-download allowlist and with every redirect
 * hop re-validated.
 *
 * @throws {BlockedHostError} when the URL — or any redirect target — is not
 *   allowed. A blocked redirect is the interesting case: it means a mirror
 *   tried to bounce us somewhere else, and it must fail loudly.
 */
export async function allowlistedFetch(
  url: string,
  options: AllowlistedFetchOptions = {},
): Promise<Response> {
  const { fetchImpl, ...init } = options
  const doFetch: FetchLike = fetchImpl ?? ((u, i) => globalThis.fetch(u, i))

  let current = assertAllowedUrl(url).toString()

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await doFetch(current, { ...init, redirect: 'manual' })

    if (!isRedirect(response.status)) return response

    const location = response.headers.get('location')
    if (!location) return response

    // Relative redirects are legal; resolve against the hop we are on.
    const next = new URL(location, current).toString()
    assertAllowedUrl(next)
    current = next
  }

  throw new Error(`Too many redirects (>${MAX_REDIRECTS}) starting at ${scrubSecrets(url)}`)
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

// ---------------------------------------------------------------------------
// Loopback (sidecars)
// ---------------------------------------------------------------------------

/**
 * Hosts the sidecar clients may use. This is the *opposite* guarantee to the
 * allowlist above: a request that thinks it is going to our local
 * `whisper-server` must never end up on the internet, so a mistyped base URL
 * fails instead of leaking a prompt (PLAN §10.3).
 */
export function isLoopbackHost(host: string): boolean {
  const normalised = host.toLowerCase().replace(/^\[|\]$/g, '')
  return normalised === '127.0.0.1' || normalised === 'localhost' || normalised === '::1'
}

/**
 * True for addresses that are local-network but not loopback (RFC 1918 and
 * friends). PLAN §7.1: an external polish endpoint here is allowed but warned
 * about; anything outside both sets gets a louder warning.
 */
export function isPrivateHost(host: string): boolean {
  const normalised = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (isLoopbackHost(normalised)) return true
  if (normalised.endsWith('.local')) return true
  // fc00::/7 — IPv6 unique-local.
  if (/^f[cd][0-9a-f]{2}:/.test(normalised)) return true

  const parts = normalised.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map((part) => Number.parseInt(part, 10))
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false

  const [a = -1, b = -1] = octets
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true
  return false
}
