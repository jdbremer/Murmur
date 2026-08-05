import { z } from 'zod'

/**
 * The hardware advisor (PLAN §8, §14).
 *
 * Machine facts are gathered in the main process (`os.arch()`, `os.totalmem()`)
 * and combined with each catalog entry's `ramTierGb` to badge it. The mapping
 * itself is a pure function so it can be unit-tested per tier.
 */

export const HardwareFitSchema = z.enum(['runsWell', 'tight', 'notRecommended'])
export type HardwareFit = z.infer<typeof HardwareFitSchema>

export const MachineProfileSchema = z.object({
  /** `arm64` (Apple Silicon) or `x64` (Intel). */
  arch: z.string().min(1),
  /** Physical RAM in GiB, rounded to one decimal. */
  totalRamGb: z.number().positive(),
  /** True on Apple Silicon: Metal-accelerated sidecars, tier A/B (PLAN §14). */
  appleSilicon: z.boolean(),
})
export type MachineProfile = z.infer<typeof MachineProfileSchema>

export const HardwareReportSchema = z.object({
  machine: MachineProfileSchema,
  /** Catalog model id → fit badge. */
  fits: z.record(z.string(), HardwareFitSchema),
})
export type HardwareReport = z.infer<typeof HardwareReportSchema>

/**
 * Badge one model for one machine.
 *
 * The rule (PLAN §14's "RAM guardrail"): a model wants `ramTierGb` of physical
 * memory. Machines at or above that run it well. Machines within 75% of it are
 * *tight* — it will load and work, but the guardrail warning applies. Below
 * that it is not recommended. Intel Macs are demoted one step because they have
 * no Metal path for the sidecars and land in tier C.
 */
export function fitForMachine(machine: MachineProfile, ramTierGb: number): HardwareFit {
  const ratio = machine.totalRamGb / ramTierGb
  const base: HardwareFit = ratio >= 1 ? 'runsWell' : ratio >= 0.75 ? 'tight' : 'notRecommended'
  if (machine.appleSilicon) return base
  return demote(base)
}

function demote(fit: HardwareFit): HardwareFit {
  switch (fit) {
    case 'runsWell':
      return 'tight'
    case 'tight':
    case 'notRecommended':
      return 'notRecommended'
  }
}
