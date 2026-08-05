/**
 * The **only** ways Murmur reaches a network (PLAN §10.2, §10.3, §15.3).
 *
 * Three wrappers with declared guarantees, and nothing else:
 *
 *  - {@link allowlistedFetch} — model downloads. Refuses any host that is not
 *    on the Hugging Face allowlist, and re-checks every redirect hop.
 *  - {@link sidecarReleaseFetch} — the user-initiated whisper/llama binary
 *    install. Same redirect discipline, against its own GitHub-releases host
 *    list, so "we only talk to Hugging Face" stays a true statement about
 *    *model* traffic rather than quietly covering an executable download.
 *  - {@link updateCheckFetch} — the user-pressed "Check for updates", against
 *    the GitHub API alone. Separate again because it is the one request that
 *    describes the *user* (an IP, a version, a moment) rather than a file they
 *    asked for.
 *  - {@link loopbackFetch} — the sidecar clients. Refuses any host that is
 *    *not* loopback, so a request that thinks it is going to our local
 *    `whisper-server` or `llama-server` can never end up on the internet.
 *
 * A reviewer can verify the claim: `fetch(` in `src/main` resolves to this
 * file's three wrappers, plus the polish `ChatClient`, which takes its fetch as
 * an explicit constructor argument — {@link loopbackFetch} when it fronts the
 * bundled llama-server, the plain global when the user configured their own
 * endpoint (allowed by PLAN §7.1, and loudly warned about in the engine status
 * when it is not loopback).
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
// Sidecar releases (whisper-server / llama-server prebuilds)
// ---------------------------------------------------------------------------

/**
 * Hosts the in-app sidecar install may touch. Separate from the model
 * allowlist on purpose: this fetches an **executable**, not weights, and the
 * privacy copy users read ("model downloads from Hugging Face") should not
 * silently expand to cover it. GitHub 302s release assets to its object CDN,
 * so those hosts are listed explicitly rather than followed blindly.
 */
const SIDECAR_HOSTS: readonly string[] = Object.freeze([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
])

export function isSidecarReleaseHost(host: string): boolean {
  return SIDECAR_HOSTS.includes(host.toLowerCase())
}

/** The sidecar host list, for the Help panel's "what we contact" disclosure. */
export function sidecarReleaseHosts(): readonly string[] {
  return [...SIDECAR_HOSTS]
}

function assertSidecarUrl(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new BlockedHostError(url, '<unparseable>')
  }
  if (parsed.protocol !== 'https:') {
    throw new BlockedHostError(url, `${parsed.hostname} (${parsed.protocol})`)
  }
  if (!isSidecarReleaseHost(parsed.hostname)) {
    throw new BlockedHostError(url, parsed.hostname)
  }
  return parsed
}

/**
 * `fetch` for the sidecar prebuilds, with the same manual-redirect discipline
 * {@link allowlistedFetch} uses: `redirect: 'follow'` would let hop #2 land on
 * any host at all, which is precisely what a release-asset CDN redirect
 * looks like to an attacker who controls DNS.
 *
 * @throws {BlockedHostError} when the URL — or any redirect target — is not a
 *   GitHub release host.
 */
export async function sidecarReleaseFetch(
  url: string,
  options: AllowlistedFetchOptions = {},
): Promise<Response> {
  const { fetchImpl, ...init } = options
  const doFetch: FetchLike = fetchImpl ?? ((u, i) => globalThis.fetch(u, i))

  let current = assertSidecarUrl(url).toString()

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await doFetch(current, { ...init, redirect: 'manual' })
    if (!isRedirect(response.status)) return response

    const location = response.headers.get('location')
    if (!location) return response

    const next = new URL(location, current).toString()
    assertSidecarUrl(next)
    current = next
  }

  throw new Error(`Too many redirects (>${MAX_REDIRECTS}) starting at ${scrubSecrets(url)}`)
}

// ---------------------------------------------------------------------------
// Update check
// ---------------------------------------------------------------------------

/**
 * The single host the update check may touch — its own list again, for the
 * same reason the sidecar hosts are separate: an update check is the one
 * request that says something about *this user* rather than about a file they
 * asked for. It reveals an IP, a version and a moment in time, so it must never
 * be able to hide inside "model downloads from Hugging Face".
 *
 * Nothing calls this on a timer. It runs when the user presses the button, and
 * the Help panel says so.
 */
const UPDATE_HOSTS: readonly string[] = Object.freeze(['api.github.com'])

export function isUpdateHost(host: string): boolean {
  return UPDATE_HOSTS.includes(host.toLowerCase())
}

/** The update host list, for the Help panel's "what we contact" disclosure. */
export function updateHosts(): readonly string[] {
  return [...UPDATE_HOSTS]
}

function assertUpdateUrl(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new BlockedHostError(url, '<unparseable>')
  }
  if (parsed.protocol !== 'https:') {
    throw new BlockedHostError(url, `${parsed.hostname} (${parsed.protocol})`)
  }
  if (!isUpdateHost(parsed.hostname)) {
    throw new BlockedHostError(url, parsed.hostname)
  }
  return parsed
}

/**
 * `fetch` for the release metadata behind "Check for updates".
 *
 * Redirects are refused outright rather than followed: the API answers
 * directly, so a redirect here is an anomaly, not a CDN hop.
 *
 * @throws {BlockedHostError} when the URL is not the GitHub API.
 */
export async function updateCheckFetch(
  url: string,
  options: AllowlistedFetchOptions = {},
): Promise<Response> {
  const { fetchImpl, ...init } = options
  const doFetch: FetchLike = fetchImpl ?? ((u, i) => globalThis.fetch(u, i))
  const target = assertUpdateUrl(url).toString()
  return doFetch(target, { ...init, redirect: 'error' })
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

export class NonLoopbackHostError extends Error {
  override readonly name = 'NonLoopbackHostError'
  readonly host: string

  constructor(url: string, host: string) {
    super(
      `Refused to send a sidecar request to "${host}" — sidecar traffic must stay on ` +
        `loopback (PLAN §10.3). URL: ${scrubSecrets(url)}`,
    )
    this.host = host
  }
}

/**
 * Plain `RequestInit` plus the two conveniences every sidecar call wants.
 * Extending `RequestInit` unmodified is deliberate: it makes `loopbackFetch`
 * itself a valid {@link FetchLike}, so it can be handed to the polish
 * `ChatClient` as its transport.
 */
export interface LoopbackFetchOptions extends RequestInit {
  /** Bearer token added as an `authorization` header. */
  token?: string | undefined
  /** Overrides `globalThis.fetch`; tests pass a fake. */
  fetchImpl?: FetchLike
}

/**
 * `fetch`, restricted to loopback — the inverse guarantee to
 * {@link allowlistedFetch}. A mistyped sidecar base URL fails here instead of
 * leaking audio or a prompt (PLAN §10.3).
 *
 * @throws {NonLoopbackHostError} when the URL is unparseable or its host is
 *   anything but `127.0.0.1`, `localhost` or `::1`.
 */
export async function loopbackFetch(
  url: string,
  options: LoopbackFetchOptions = {},
): Promise<Response> {
  const { token, fetchImpl, ...init } = options

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new NonLoopbackHostError(url, '<unparseable>')
  }
  if (!isLoopbackHost(parsed.hostname)) {
    throw new NonLoopbackHostError(url, parsed.hostname)
  }

  const headers = new Headers(init.headers)
  if (token) headers.set('authorization', `Bearer ${token}`)

  const doFetch: FetchLike = fetchImpl ?? ((u, i) => globalThis.fetch(u, i))
  // `redirect: 'error'`, unconditionally — a caller-supplied value is ignored.
  // fetch's default is to follow up to 20 hops, and hop #2 can leave loopback:
  // whatever answers on the port could 307 the body — audio, a prompt —
  // straight off the machine. A sidecar has no business redirecting at all, so
  // any redirect is treated as the attack it would be.
  return doFetch(url, { ...init, headers, redirect: 'error' })
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
