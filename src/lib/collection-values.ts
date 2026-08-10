/**
 * Presentation for operator-defined collection fields.
 *
 * A theme receives these fields with no schema attached. The context carries
 * `values` keyed by field id and a collection identity, and nothing that says
 * what any field is, so a theme cannot ask whether `hero` is an image or a
 * sentence. Presentation is therefore inferred from the value itself.
 *
 * That is sound rather than a guess: the platform validates every value against
 * its declared type before publishing, so an image is always `{ src, alt }`
 * with an https source, a resolved reference always carries the entry it names,
 * and a date is always a real calendar date. What reaches here has already been
 * proven to match one of these shapes.
 */

/** A reference the platform resolved to the entry it names, one hop deep. */
type ResolvedReference = {
  title: string
  path?: string
}

type ImageValue = {
  src: string
  alt: string
}

export type CollectionValue =
  | { kind: "reference"; reference: ResolvedReference }
  | { kind: "image"; image: ImageValue }
  | { kind: "text"; text: string }
  | { kind: "list"; items: CollectionValue[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Classifies one published value, or returns null for an absence.
 *
 * An unresolvable reference is left as the bare id by the platform rather than
 * dropped, so it arrives here as a string and renders as text. That is the
 * intended outcome: showing the id is worse than showing the title and better
 * than silently showing nothing.
 */
export function classifyCollectionValue(value: unknown): CollectionValue | null {
  if (value === null || value === undefined || value === "") return null

  if (Array.isArray(value)) {
    const items = value
      .map(classifyCollectionValue)
      .filter((item): item is CollectionValue => item !== null)
    return items.length > 0 ? { kind: "list", items } : null
  }

  if (isRecord(value)) {
    // Checked before the reference, because only an image carries `src`.
    if (typeof value.src === "string" && typeof value.alt === "string") {
      return { kind: "image", image: { src: value.src, alt: value.alt } }
    }
    if (typeof value.title === "string") {
      return {
        kind: "reference",
        reference: {
          title: value.title,
          ...(typeof value.path === "string" ? { path: value.path } : {}),
        },
      }
    }
    return null
  }

  if (typeof value === "boolean") {
    return { kind: "text", text: value ? "Yes" : "No" }
  }
  if (typeof value === "number" || typeof value === "string") {
    return { kind: "text", text: String(value) }
  }
  return null
}

/**
 * A readable label for a field id.
 *
 * Field ids are lowercase and hyphenated by the document contract, and the
 * operator's own label never reaches a theme, so this is the best name
 * available. It restores spacing and a leading capital and changes nothing
 * else, because inventing wording for someone else's field would be worse than
 * showing their id plainly.
 */
export function fieldLabel(id: string): string {
  const spaced = id.replace(/[-_]+/g, " ").trim()
  if (spaced === "") return id
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** A field definition as the platform publishes it alongside the values. */
export type CollectionFieldDefinition = {
  id: string
  label: string
}

/**
 * The fields of an entry to display, in the order to display them.
 *
 * When the collection publishes its declared fields, that is the answer: the
 * operator's own labels, in the order they arranged them. Everything else is a
 * fallback for a publication materialized before those definitions existed,
 * where `values` is all there is — the id humanized, the keys sorted, because
 * showing them in whatever order the serializer produced would reorder a page
 * for no reason an operator could see.
 *
 * Values with no matching definition are still shown, after the declared ones.
 * A field removed from the collection leaves its authored values behind, and an
 * entry that silently stopped rendering half its content would be worse than
 * one that shows a field the operator has stopped maintaining.
 */
export function entryFields(
  values: Record<string, unknown>,
  fields?: readonly CollectionFieldDefinition[],
): Array<{ id: string; label: string; value: CollectionValue }> {
  const present = (id: string, label: string) => {
    const value = classifyCollectionValue(values[id])
    return value === null ? [] : [{ id, label, value }]
  }

  if (!fields || fields.length === 0) {
    return Object.keys(values)
      .sort()
      .flatMap((id) => present(id, fieldLabel(id)))
  }

  const declared = new Set(fields.map((field) => field.id))
  return [
    ...fields.flatMap((field) => present(field.id, field.label)),
    ...Object.keys(values)
      .filter((id) => !declared.has(id))
      .sort()
      .flatMap((id) => present(id, fieldLabel(id))),
  ]
}

/**
 * The short description to show for an entry, whichever way the site supplies it.
 *
 * A bound site answers through the theme's own slot, so the operator's field id
 * never reaches here. An unbound one has no mapping at all, and the best that
 * can be done is the first readable text in declared order — which is what this
 * theme did before bindings existed and must keep doing, because a theme cannot
 * require a mapping that predates it.
 */
export function entryBlurb(
  entry: { values: Record<string, unknown>; binding?: Record<string, unknown> },
  fields?: readonly CollectionFieldDefinition[],
): string | null {
  const bound = classifyCollectionValue(entry.binding?.blurb)
  if (bound?.kind === "text") return bound.text

  for (const field of entryFields(entry.values, fields)) {
    if (field.value.kind === "text") return field.value.text
  }
  return null
}

/** The byline to show, or null when the site maps none. */
export function entryByline(entry: {
  binding?: Record<string, unknown>
}): CollectionValue | null {
  return classifyCollectionValue(entry.binding?.byline)
}
