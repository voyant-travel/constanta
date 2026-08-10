import { cleanStega } from "@voyant-travel/theme"

export type SectionSettings = Record<string, unknown>

export interface SectionBlockInstance {
  id: string
  type: string
  settings: SectionSettings
}

export interface SectionInstance {
  type: string
  data: {
    id: string
    settings: SectionSettings
    blocks: SectionBlockInstance[]
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Read the publication's stable section envelope without guessing at legacy or
 * platform-internal shapes. An unknown section type remains a valid instance;
 * the renderer decides whether this release knows how to present it.
 */
export function sectionInstances(input: unknown): SectionInstance[] {
  if (!Array.isArray(input)) return []

  return input.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.type !== "string") return []
    if (!isRecord(candidate.data)) return []
    const { id, settings, blocks } = candidate.data
    if (typeof id !== "string" || !isRecord(settings) || !Array.isArray(blocks)) {
      return []
    }

    const parsedBlocks = blocks.flatMap((block) => {
      if (
        !isRecord(block) ||
        typeof block.id !== "string" ||
        typeof block.type !== "string" ||
        !isRecord(block.settings)
      ) {
        return []
      }
      return [{ id: block.id, type: block.type, settings: block.settings }]
    })

    return [
      {
        type: candidate.type,
        data: { id, settings, blocks: parsedBlocks },
      },
    ]
  })
}

/** Visible strings stay untouched so draft stega provenance reaches a text node. */
export function visibleSetting(
  settings: SectionSettings,
  id: string,
): string | undefined {
  const value = settings[id]
  return typeof value === "string" && cleanStega(value).trim() !== ""
    ? value
    : undefined
}

/** Attribute values are not text nodes, so carrying stega there has no editor value. */
export function attributeSetting(
  settings: SectionSettings,
  id: string,
): string | undefined {
  const value = visibleSetting(settings, id)
  return value ? cleanStega(value) : undefined
}

/** Metadata uses the visible value, never its invisible provenance suffix. */
export function choiceSetting<T extends string>(
  settings: SectionSettings,
  id: string,
  choices: readonly T[],
  fallback: T,
): T {
  const value = settings[id]
  if (typeof value !== "string") return fallback
  const clean = cleanStega(value)
  return choices.includes(clean as T) ? (clean as T) : fallback
}

export function numberSetting(
  settings: SectionSettings,
  id: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const value = settings[id]
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback
}

export function booleanSetting(
  settings: SectionSettings,
  id: string,
  fallback: boolean,
): boolean {
  const value = settings[id]
  return typeof value === "boolean" ? value : fallback
}

export function linkSetting(
  settings: SectionSettings,
  id: string,
): string | undefined {
  const value = settings[id]
  if (typeof value !== "string") return undefined
  const clean = cleanStega(value).trim()
  if (/^\/(?!\/)/.test(clean) || /^(?:https?:|mailto:|tel:)/i.test(clean)) {
    return clean
  }
  return undefined
}

export function imageSetting(
  settings: SectionSettings,
  id: string,
): string | undefined {
  const value = settings[id]
  if (typeof value !== "string") return undefined
  const clean = cleanStega(value).trim()
  return /^\/(?!\/)/.test(clean) || /^https:\/\//i.test(clean)
    ? clean
    : undefined
}

export function colorSetting(
  settings: SectionSettings,
  id: string,
  fallback: string,
): string {
  const value = settings[id]
  if (typeof value !== "string") return fallback
  const clean = cleanStega(value).trim()
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(clean) ? clean : fallback
}
