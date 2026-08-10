import type {
  ThemeCapabilityId,
  ThemeLive,
  ThemeLiveCapability,
} from "@voyant-travel/theme"

export function availableCapability(
  live: ThemeLive | undefined,
  id: ThemeCapabilityId,
): ThemeLiveCapability | undefined {
  return live?.capabilities.find(
    (capability) =>
      capability.id === id && capability.available && capability.endpoint,
  )
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function responseRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(record).filter(Boolean)
  const envelope = record(value)
  if (!envelope) return []
  for (const key of ["data", "rows", "products", "items"] as const) {
    const rows = envelope[key]
    if (Array.isArray(rows)) return rows.map(record).filter(Boolean)
  }
  return []
}

export function rowText(
  row: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}
