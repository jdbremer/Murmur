import { describe, expect, it, vi } from 'vitest'

import {
  allowedHosts,
  allowlistedFetch,
  assertAllowedUrl,
  BlockedHostError,
  isAllowedHost,
  isLoopbackHost,
  isPrivateHost,
} from '../src/main/net/fetch'

/**
 * The network allowlist (PLAN §10.2, §15.3).
 *
 * "No audio, transcript, or telemetry ever leaves the device" is the product's
 * entire pitch, and the code-level enforcement is this one wrapper. PLAN §15.3
 * asks for an integration test behind a recording proxy; this is the unit half
 * of that — the part that can prove a *blocked redirect* fails, which a proxy
 * test would only catch if the mirror actually tried it.
 */

function response(status: number, location?: string): Response {
  const headers = new Headers()
  if (location) headers.set('location', location)
  return new Response(null, { status, headers })
}

describe('isAllowedHost', () => {
  it('allows the Hugging Face hosts and their CDNs', () => {
    expect(isAllowedHost('huggingface.co')).toBe(true)
    expect(isAllowedHost('cdn-lfs.huggingface.co')).toBe(true)
    expect(isAllowedHost('cas-bridge.xethub.hf.co')).toBe(true)
    // The wildcard suffixes cover the regional CDN hosts HF actually serves from.
    expect(isAllowedHost('us.aws.cdn.hf.co')).toBe(true)
    expect(isAllowedHost('eu-west-1.cdn.hf.co')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isAllowedHost('HuggingFace.CO')).toBe(true)
  })

  it('refuses everything else, including lookalikes', () => {
    expect(isAllowedHost('example.com')).toBe(false)
    expect(isAllowedHost('telemetry.murmur.app')).toBe(false)
    // Suffix matching must not be fooled by a host that merely *contains* ours.
    expect(isAllowedHost('huggingface.co.evil.com')).toBe(false)
    expect(isAllowedHost('nothuggingface.co')).toBe(false)
    expect(isAllowedHost('evilcdn.hf.co.attacker.net')).toBe(false)
  })

  it('publishes the list for the Help panel', () => {
    expect(allowedHosts()).toContain('huggingface.co')
    expect(allowedHosts().some((host) => host.startsWith('*'))).toBe(true)
  })
})

describe('assertAllowedUrl', () => {
  it('accepts an https URL on an allow-listed host', () => {
    expect(assertAllowedUrl('https://huggingface.co/a/b').hostname).toBe('huggingface.co')
  })

  it('refuses a non-allow-listed host, naming it', () => {
    expect(() => assertAllowedUrl('https://evil.example/model.bin')).toThrow(BlockedHostError)
    try {
      assertAllowedUrl('https://evil.example/model.bin')
    } catch (error) {
      expect((error as BlockedHostError).host).toBe('evil.example')
      expect((error as BlockedHostError).message).toContain('only talks to Hugging Face')
    }
  })

  it('refuses plain http even on an allowed host', () => {
    expect(() => assertAllowedUrl('http://huggingface.co/a')).toThrow(BlockedHostError)
  })

  it('refuses non-http schemes outright', () => {
    expect(() => assertAllowedUrl('file:///etc/passwd')).toThrow(BlockedHostError)
    expect(() => assertAllowedUrl('data:text/plain,hi')).toThrow(BlockedHostError)
  })

  it('refuses an unparseable URL', () => {
    expect(() => assertAllowedUrl('not a url')).toThrow(BlockedHostError)
  })
})

describe('allowlistedFetch', () => {
  it('fetches an allowed URL', async () => {
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      response(200),
    )
    const result = await allowlistedFetch('https://huggingface.co/model.bin', { fetchImpl })

    expect(result.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledOnce()
    // Redirects are followed by hand so each hop can be re-checked.
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' })
  })

  it('refuses a blocked URL without making a request', async () => {
    const fetchImpl = vi.fn(async () => response(200))
    await expect(allowlistedFetch('https://evil.example/x', { fetchImpl })).rejects.toThrow(
      BlockedHostError,
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('follows a redirect to another allowed host', async () => {
    const fetchImpl = vi
      .fn<(url: string) => Promise<Response>>()
      .mockResolvedValueOnce(response(302, 'https://us.aws.cdn.hf.co/blob/abc'))
      .mockResolvedValueOnce(response(200))

    const result = await allowlistedFetch('https://huggingface.co/model.bin', { fetchImpl })
    expect(result.status).toBe(200)
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://us.aws.cdn.hf.co/blob/abc')
  })

  it('BLOCKS a redirect that leaves the allowlist — the interesting case', async () => {
    const fetchImpl = vi.fn(async () => response(302, 'https://exfiltrate.example/collect'))

    await expect(
      allowlistedFetch('https://huggingface.co/model.bin', { fetchImpl }),
    ).rejects.toThrow(BlockedHostError)

    // The first hop was made; the second must never be.
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('resolves a relative redirect against the current hop', async () => {
    const fetchImpl = vi
      .fn<(url: string) => Promise<Response>>()
      .mockResolvedValueOnce(response(307, '/other/path'))
      .mockResolvedValueOnce(response(200))

    await allowlistedFetch('https://huggingface.co/a/b', { fetchImpl })
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://huggingface.co/other/path')
  })

  it('gives up after too many redirects', async () => {
    const fetchImpl = vi.fn(async () => response(302, 'https://huggingface.co/loop'))
    await expect(allowlistedFetch('https://huggingface.co/start', { fetchImpl })).rejects.toThrow(
      /Too many redirects/,
    )
  })

  it('returns a redirect with no Location rather than looping', async () => {
    const fetchImpl = vi.fn(async () => response(302))
    const result = await allowlistedFetch('https://huggingface.co/a', { fetchImpl })
    expect(result.status).toBe(302)
  })
})

describe('loopback and private-network classification (PLAN §7.1, §10.3)', () => {
  it('recognises loopback', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
    expect(isLoopbackHost('10.0.0.5')).toBe(false)
  })

  it('recognises RFC-1918 and link-local addresses', () => {
    expect(isPrivateHost('10.0.0.5')).toBe(true)
    expect(isPrivateHost('192.168.1.10')).toBe(true)
    expect(isPrivateHost('172.16.0.1')).toBe(true)
    expect(isPrivateHost('172.31.255.254')).toBe(true)
    expect(isPrivateHost('169.254.1.1')).toBe(true)
    expect(isPrivateHost('mac-studio.local')).toBe(true)
    expect(isPrivateHost('fd00::1')).toBe(true)
  })

  it('does not mistake 172.15 or 172.32 for RFC-1918', () => {
    expect(isPrivateHost('172.15.0.1')).toBe(false)
    expect(isPrivateHost('172.32.0.1')).toBe(false)
  })

  it('treats public hosts as public', () => {
    expect(isPrivateHost('api.openai.com')).toBe(false)
    expect(isPrivateHost('8.8.8.8')).toBe(false)
  })

  it('does not accept malformed dotted quads', () => {
    expect(isPrivateHost('10.0.0')).toBe(false)
    expect(isPrivateHost('10.0.0.999')).toBe(false)
    expect(isPrivateHost('10.a.b.c')).toBe(false)
  })
})
