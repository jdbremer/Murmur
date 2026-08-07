import { describe, expect, it, vi } from 'vitest'

import {
  allowedHosts,
  allowlistedFetch,
  assertAllowedUrl,
  BlockedHostError,
  isAllowedHost,
  isLoopbackHost,
  isPrivateHost,
  isSidecarReleaseHost,
  loopbackFetch,
  NonLoopbackHostError,
  sidecarReleaseFetch,
  sidecarReleaseHosts,
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

describe('sidecar release hosts', () => {
  /**
   * The sidecar install fetches an *executable*, so it keeps its own list. The
   * model allowlist now also covers Murmur's release assets (Parakeet's ONNX
   * lives there), but the separation still means something: only the sidecar
   * list may serve a binary that gets executed.
   */
  it('allows GitHub releases and their asset CDN, nothing else', () => {
    expect(isSidecarReleaseHost('github.com')).toBe(true)
    expect(isSidecarReleaseHost('objects.githubusercontent.com')).toBe(true)
    expect(isSidecarReleaseHost('GitHub.com')).toBe(true)
    expect(isSidecarReleaseHost('evil.example')).toBe(false)
    // Must not inherit the model allowlist, or the separation is decorative.
    expect(isSidecarReleaseHost('huggingface.co')).toBe(false)
    expect(sidecarReleaseHosts()).toContain('github.com')
  })

  it('lets model downloads reach Murmur’s own release assets', () => {
    // Parakeet forced this: NVIDIA publishes .nemo, safetensors and a GGUF but
    // no ONNX, so the ONNX conversion is ours and lives on a release of this
    // repo. The two lists still differ — the sidecar list is executables only —
    // but "models come from Hugging Face" is no longer the whole truth, and the
    // Help panel says so too.
    expect(isAllowedHost('github.com')).toBe(true)
    expect(isAllowedHost('release-assets.githubusercontent.com')).toBe(true)
    expect(isAllowedHost('evil.example')).toBe(false)
    expect(isAllowedHost('github.com.evil.example')).toBe(false)
  })

  it('re-validates every redirect hop instead of following blindly', async () => {
    // A release asset always redirects; `redirect: 'follow'` would let hop #2
    // land anywhere at all, which is the whole point of doing this manually.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(302, 'https://evil.example/payload.zip'))

    await expect(
      sidecarReleaseFetch('https://github.com/o/r/releases/download/v1/x.zip', { fetchImpl }),
    ).rejects.toThrow(BlockedHostError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('follows a redirect that stays on an allowed asset host', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(302, 'https://objects.githubusercontent.com/x.zip'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const result = await sidecarReleaseFetch('https://github.com/o/r/releases/download/v1/x.zip', {
      fetchImpl,
    })
    expect(result.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('refuses plain http', async () => {
    await expect(sidecarReleaseFetch('http://github.com/x.zip')).rejects.toThrow(BlockedHostError)
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
      expect((error as BlockedHostError).message).toContain('only downloads models from')
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

describe('loopbackFetch', () => {
  const ok = (): Promise<Response> => Promise.resolve(new Response('ok'))

  it('allows the three loopback spellings', async () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      const fetchImpl = vi.fn(ok)
      await loopbackFetch(`http://${host}:9999/inference`, { fetchImpl })
      expect(fetchImpl).toHaveBeenCalledOnce()
    }
  })

  it('refuses anything that is not loopback — that is its whole job', async () => {
    const fetchImpl = vi.fn(ok)
    for (const url of [
      'http://192.168.1.20:8080/v1/chat/completions',
      'https://api.example.com/inference',
      'http://10.0.0.5/health',
    ]) {
      await expect(loopbackFetch(url, { fetchImpl })).rejects.toBeInstanceOf(NonLoopbackHostError)
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses an unparseable URL rather than guessing', async () => {
    await expect(loopbackFetch('not a url', { fetchImpl: vi.fn(ok) })).rejects.toBeInstanceOf(
      NonLoopbackHostError,
    )
  })

  it('adds the bearer token without clobbering other headers', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer sesame')
      expect(headers.get('content-type')).toBe('application/json')
      return ok()
    })
    await loopbackFetch('http://127.0.0.1:1234/x', {
      fetchImpl,
      token: 'sesame',
      headers: { 'content-type': 'application/json' },
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('passes method, body and signal through untouched', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      expect(init?.body).toBe('{"a":1}')
      expect(init?.signal).toBe(controller.signal)
      return ok()
    })
    await loopbackFetch('http://localhost:7777/y', {
      fetchImpl,
      method: 'POST',
      body: '{"a":1}',
      signal: controller.signal,
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
})

describe('loopbackFetch redirect policy', () => {
  it('forces redirect: "error" so a hop can never leave loopback', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe('error')
      return Promise.resolve(new Response('ok'))
    })
    await loopbackFetch('http://127.0.0.1:9000/inference', { fetchImpl })
    // Even a caller who asks for 'follow' is overruled — the guarantee is not
    // configurable.
    await loopbackFetch('http://127.0.0.1:9000/inference', {
      fetchImpl,
      redirect: 'follow',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
