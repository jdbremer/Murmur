import { arch, cpus, totalmem } from 'node:os'

import {
  fitForMachine,
  type HardwareFit,
  type HardwareReport,
  type MachineProfile,
  type ModelEntry,
} from '@murmur/shared'

/**
 * The hardware advisor (PLAN §8, §14).
 *
 * Detects the machine once and badges every catalog entry *Runs well* / *Tight*
 * / *Not recommended*. The mapping rule itself lives in `@murmur/shared` so the
 * renderer could apply it too; this file is only the "what machine is this"
 * half, which needs Node.
 *
 * Apple Silicon detection deliberately does not shell out to `system_profiler`
 * — spawning a process on every Hub render to learn something `os.arch()`
 * already tells us would be silly. The one case it gets wrong is Rosetta (an
 * x64 build on an M-series Mac reports `x64`), and the CPU-model check catches
 * that.
 */

export function detectMachine(): MachineProfile {
  const architecture = arch()
  const totalRamGb = Math.round((totalmem() / 1024 ** 3) * 10) / 10
  return {
    arch: architecture,
    totalRamGb: Math.max(0.1, totalRamGb),
    appleSilicon: isAppleSilicon(architecture),
  }
}

/**
 * True on M-series hardware, including an x64 build running under Rosetta —
 * where `arch()` lies but the CPU model string does not.
 */
function isAppleSilicon(architecture: string): boolean {
  if (process.platform !== 'darwin') return false
  if (architecture === 'arm64') return true
  const model = cpus()[0]?.model ?? ''
  return /Apple\s+M\d/i.test(model)
}

/** Badge every entry for this machine. */
export function buildHardwareReport(
  entries: readonly ModelEntry[],
  machine: MachineProfile = detectMachine(),
): HardwareReport {
  const fits: Record<string, HardwareFit> = {}
  for (const entry of entries) {
    fits[entry.id] = fitForMachine(machine, entry.ramTierGb)
  }
  return { machine, fits }
}

/**
 * Would loading this pair breach PLAN §14's "warn above ~60% of physical RAM"
 * guardrail? Returns the warning text, or `null` when the combo is fine.
 */
export function combinedLoadWarning(
  stt: ModelEntry | null,
  polish: ModelEntry | null,
  machine: MachineProfile = detectMachine(),
): string | null {
  const wanted = (stt?.ramTierGb ?? 0) + (polish?.ramTierGb ?? 0)
  if (wanted === 0) return null
  const budget = machine.totalRamGb * 0.6
  if (wanted <= budget) return null
  return (
    `${stt?.displayName ?? 'no STT model'} + ${polish?.displayName ?? 'no polish model'} want ` +
    `about ${wanted.toFixed(1)} GB, more than 60% of this machine's ${machine.totalRamGb} GB. ` +
    `Expect swapping — consider a smaller model or turning polishing off.`
  )
}
