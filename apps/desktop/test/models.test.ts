import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  fitForMachine,
  validateCatalog,
  type MachineProfile,
  type ModelEntry,
} from '@murmur/shared'

import { createNullLogger } from '../src/main/logging'
import {
  buildHardwareReport,
  combinedLoadWarning,
  detectMachine,
} from '../src/main/models/hardware'
import { ModelManager } from '../src/main/models/manager'
import {
  deleteModel,
  directorySize,
  isModelInstalled,
  listInstalled,
  modelsRoot,
  resolveModelPath,
  totalDiskUsage,
  UnsafeModelPathError,
} from '../src/main/models/storage'

/**
 * Model storage, the hardware advisor and the manager (PLAN §8, §14, §15.3).
 *
 * `resolveModelPath` gets the most attention: it is the one place a
 * renderer-reachable string (a model id, a catalog filename) is turned into a
 * filesystem path, which PLAN §15.3 names as a sensitive path.
 */

const log = createNullLogger()
let userData: string
let root: string

function entry(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id: 'test-model',
    kind: 'stt',
    engine: 'whisper-cpp',
    displayName: 'Test Model',
    org: 'Test Org',
    origin: 'US',
    license: 'MIT',
    sizeBytes: 11,
    ramTierGb: 8,
    languages: ['en'],
    quant: 'q5_0',
    files: [
      {
        url: 'https://huggingface.co/org/repo/resolve/main/ggml.bin',
        sha256: 'a'.repeat(64),
        bytes: 11,
        filename: 'ggml.bin',
      },
    ],
    ...overrides,
  }
}

function install(id: string, files: Record<string, string>): void {
  const directory = join(root, id)
  mkdirSync(directory, { recursive: true })
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(directory, name), contents)
  }
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'murmur-models-'))
  root = modelsRoot(userData)
  mkdirSync(root, { recursive: true })
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

describe('resolveModelPath', () => {
  it('joins safe components under the root', () => {
    expect(resolveModelPath(root, 'model-id', 'file.bin')).toBe(join(root, 'model-id', 'file.bin'))
  })

  it('refuses path traversal in any component', () => {
    for (const bad of ['..', '../escape', 'a/b', 'a\\b', '/absolute', '', '.']) {
      expect(() => resolveModelPath(root, bad), `"${bad}" should be refused`).toThrow(
        UnsafeModelPathError,
      )
    }
  })

  it('refuses a NUL byte', () => {
    expect(() => resolveModelPath(root, 'evil\0.bin')).toThrow(UnsafeModelPathError)
  })

  it('names the offending component in the error', () => {
    expect(() => resolveModelPath(root, '../etc')).toThrow(/escapes the models directory/)
  })
})

describe('isModelInstalled', () => {
  it('is false when the directory does not exist', () => {
    expect(isModelInstalled(root, entry())).toBe(false)
  })

  it('is true when every file is present at the right size', () => {
    install('test-model', { 'ggml.bin': 'hello world' }) // 11 bytes
    expect(isModelInstalled(root, entry())).toBe(true)
  })

  it('is false when a file is the wrong size — a truncated download', () => {
    install('test-model', { 'ggml.bin': 'short' })
    expect(isModelInstalled(root, entry())).toBe(false)
  })

  it('is false when one file of several is missing', () => {
    const multi = entry({
      files: [
        { ...entry().files[0]!, filename: 'a.onnx', bytes: 3 },
        { ...entry().files[0]!, filename: 'b.onnx', bytes: 3 },
      ],
    })
    install('test-model', { 'a.onnx': 'abc' })
    expect(isModelInstalled(root, multi)).toBe(false)
  })
})

describe('disk accounting', () => {
  it('sums a directory tree', () => {
    install('model-a', { 'one.bin': 'x'.repeat(10), 'two.bin': 'y'.repeat(20) })
    expect(directorySize(join(root, 'model-a'))).toBe(30)
  })

  it('returns 0 for a missing directory', () => {
    expect(directorySize(join(root, 'nope'))).toBe(0)
  })

  it('totals every model, quarantine included', () => {
    install('model-a', { 'one.bin': 'x'.repeat(10) })
    install('model-b', { 'two.bin': 'y'.repeat(5) })
    expect(totalDiskUsage(root)).toBe(15)
  })
})

describe('listInstalled', () => {
  it('lists only catalog models that are actually complete', () => {
    install('test-model', { 'ggml.bin': 'hello world' })
    install('half-model', { 'ggml.bin': 'nope' })
    install('unknown-model', { 'x.bin': 'x' })

    const installed = listInstalled(root, [entry(), entry({ id: 'half-model' })])
    expect(installed.map((model) => model.modelId)).toEqual(['test-model'])
    expect(installed[0]).toMatchObject({ source: 'catalog', bytes: 11, engine: 'whisper-cpp' })
  })

  it('returns nothing when the root does not exist', () => {
    expect(listInstalled(join(userData, 'absent'), [entry()])).toEqual([])
  })
})

describe('deleteModel', () => {
  it('removes the directory and reports the bytes reclaimed', () => {
    install('test-model', { 'ggml.bin': 'hello world' })
    expect(deleteModel(root, 'test-model')).toBe(11)
    expect(isModelInstalled(root, entry())).toBe(false)
  })

  it('is a no-op for a model that was never installed', () => {
    expect(deleteModel(root, 'absent')).toBe(0)
  })
})

describe('hardware advisor (PLAN §14)', () => {
  const appleSilicon = (ram: number): MachineProfile => ({
    arch: 'arm64',
    totalRamGb: ram,
    appleSilicon: true,
  })
  const intel = (ram: number): MachineProfile => ({
    arch: 'x64',
    totalRamGb: ram,
    appleSilicon: false,
  })

  it('badges by the ratio of available to wanted RAM', () => {
    expect(fitForMachine(appleSilicon(16), 16)).toBe('runsWell')
    expect(fitForMachine(appleSilicon(32), 16)).toBe('runsWell')
    // 12/16 = 0.75 — exactly on the "tight" boundary.
    expect(fitForMachine(appleSilicon(12), 16)).toBe('tight')
    expect(fitForMachine(appleSilicon(8), 16)).toBe('notRecommended')
  })

  it('demotes Intel Macs one step — no Metal, tier C', () => {
    expect(fitForMachine(intel(32), 16)).toBe('tight')
    expect(fitForMachine(intel(12), 16)).toBe('notRecommended')
    expect(fitForMachine(intel(8), 16)).toBe('notRecommended')
  })

  it('builds a report keyed by model id', () => {
    const report = buildHardwareReport(
      [entry({ id: 'small', ramTierGb: 8 }), entry({ id: 'large', ramTierGb: 16 })],
      appleSilicon(8),
    )
    expect(report.fits).toEqual({ small: 'runsWell', large: 'notRecommended' })
    expect(report.machine.totalRamGb).toBe(8)
  })

  it('detects the real machine without throwing', () => {
    const machine = detectMachine()
    expect(machine.totalRamGb).toBeGreaterThan(0)
    expect(typeof machine.appleSilicon).toBe('boolean')
  })

  it('warns when a model pair exceeds 60% of physical RAM', () => {
    const stt = entry({ id: 'stt', ramTierGb: 8, displayName: 'Big STT' })
    const polish = entry({ id: 'polish', ramTierGb: 16, displayName: 'Big Polish', kind: 'polish' })

    expect(combinedLoadWarning(stt, polish, appleSilicon(16))).toContain('Big STT')
    expect(combinedLoadWarning(stt, polish, appleSilicon(64))).toBeNull()
  })

  it('does not warn when nothing is selected', () => {
    expect(combinedLoadWarning(null, null, appleSilicon(8))).toBeNull()
  })
})

describe('ModelManager', () => {
  const catalog = validateCatalog({
    schemaVersion: 1,
    updatedAt: '2026-08-05T00:00:00.000Z',
    originPolicy: ['US'],
    models: [entry(), entry({ id: 'other-model', kind: 'polish', engine: 'llama-cpp' })],
  })

  function manager(): ModelManager {
    return new ModelManager({ userDataPath: userData, catalog, log })
  }

  it('lists the catalog, what is installed, and a hardware report', () => {
    install('test-model', { 'ggml.bin': 'hello world' })
    const list = manager().list()

    expect(list.catalog.models).toHaveLength(2)
    expect(list.installed.map((model) => model.modelId)).toEqual(['test-model'])
    expect(list.diskUsageBytes).toBe(11)
    expect(Object.keys(list.hardware.fits).sort()).toEqual(['other-model', 'test-model'])
    expect(list.catalogError).toBeNull()
  })

  it('surfaces a catalog validation failure so the UI can explain the empty list', () => {
    const broken = new ModelManager({
      userDataPath: userData,
      catalog,
      catalogError: 'rejected by origin policy',
      log,
    })
    expect(broken.list().catalogError).toBe('rejected by origin policy')
  })

  it('resolves an installed model to something an engine can load', () => {
    install('test-model', { 'ggml.bin': 'hello world' })
    const ref = manager().resolve('test-model')

    expect(ref).toMatchObject({
      modelId: 'test-model',
      engine: 'whisper-cpp',
      files: ['ggml.bin'],
    })
    expect(ref?.directory).toBe(join(root, 'test-model'))
  })

  it('resolves to null for a model that is selected but not downloaded', () => {
    expect(manager().resolve('test-model')).toBeNull()
    expect(manager().resolve('not-in-catalog')).toBeNull()
    expect(manager().resolve(null)).toBeNull()
  })

  it('refuses to start a download for an unknown model', () => {
    expect(() => manager().startDownload('nope')).toThrow(/not in the catalog/)
  })

  it('deletes a model and reports the space reclaimed', () => {
    install('test-model', { 'ggml.bin': 'hello world' })
    const instance = manager()
    expect(instance.delete('test-model')).toBe(11)
    expect(instance.isInstalled('test-model')).toBe(false)
  })

  it('imports a local file, labelled origin-unverified', () => {
    const path = join(userData, 'my-model.gguf')
    writeFileSync(path, 'x'.repeat(50))

    const instance = manager()
    const imported = instance.import({
      kind: 'polish',
      engine: 'llama-cpp',
      displayName: 'My Model',
      source: { type: 'file', path },
    })

    expect(imported.origin).toBe('unverified')
    expect(imported.sizeBytes).toBe(50)
    expect(instance.list().imported).toHaveLength(1)
    expect(instance.isInstalled(imported.id)).toBe(true)
  })

  it('refuses to import a file that is not there', () => {
    expect(() =>
      manager().import({
        kind: 'polish',
        engine: 'llama-cpp',
        displayName: 'Missing',
        source: { type: 'file', path: join(userData, 'absent.gguf') },
      }),
    ).toThrow(/No such file/)
  })

  it('refuses an HF-repo import explicitly rather than pretending', () => {
    expect(() =>
      manager().import({
        kind: 'polish',
        engine: 'llama-cpp',
        displayName: 'From HF',
        source: { type: 'huggingface', repoId: 'org/repo' },
      }),
    ).toThrow(/not supported yet/)
  })

  it('emits a queued progress event as soon as a download starts', async () => {
    install('nothing', {})
    const instance = manager()
    const events: string[] = []
    instance.on('progress', (progress) => events.push(progress.status))

    const downloadId = instance.startDownload('test-model')
    expect(downloadId).toMatch(/[0-9a-f-]{36}/)
    expect(events[0]).toBe('queued')

    // Cancel immediately so the (network-bound) download does not run.
    instance.cancelDownload(downloadId)
    instance.cancelAll()
  })
})
