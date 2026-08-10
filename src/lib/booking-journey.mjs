const ACTIONS = new Set([
  "create",
  "update",
  "quote",
  "hold",
  "commit",
  "abandon",
  "renew",
  "checkout",
])

const PAYMENT_INTENTS = new Set(["card", "bank_transfer", "inquiry"])

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined
}

function string(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function readableCode(value) {
  return String(value ?? "unexpected_response")
    .replaceAll("_", " ")
    .replace(/^./, (character) => character.toUpperCase())
}

export function checkoutHandoff(value) {
  const root = record(value)
  const outcome = record(root?.outcome)
  const paymentSession = record(outcome?.paymentSession) ?? record(root?.paymentSession)
  const checkout = record(paymentSession?.checkout) ?? record(root?.checkout)
  const directUrl =
    string(checkout?.url) ??
    string(paymentSession?.redirectUrl) ??
    string(root?.redirectUrl) ??
    string(root?.url)
  if (!directUrl) return undefined
  try {
    const url = new URL(directUrl)
    const localHttp =
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    if ((url.protocol !== "https:" && !localHttp) || url.username || url.password) {
      return undefined
    }
    return { kind: string(checkout?.kind) ?? "redirect", url: url.toString() }
  } catch {
    return undefined
  }
}

export function reduceBookingState(previous, payload) {
  const root = record(payload)
  if (!root) return previous
  const error = record(root.error)
  if (root.kind === "rejected") {
    const actualRevision = number(error?.actualRevision)
    return {
      ...previous,
      ...(actualRevision === undefined ? {} : { revision: actualRevision }),
      rejection: string(error?.kind) ?? "request_rejected",
    }
  }

  const session = record(root.session)
  const quote = record(root.quote)
  const hold = record(root.hold)
  const outcome = record(root.outcome)
  const next = {
    ...previous,
    rejection: undefined,
    lastOutcome: string(root.kind) ?? "updated",
  }
  const sessionId = string(session?.id)
  const revision = number(session?.revision)
  const quoteId = string(quote?.id) ?? string(root.quoteId)
  const requirementsFingerprint =
    string(quote?.requirementsFingerprint) ?? string(root.requirementsFingerprint)
  const holdId = string(hold?.id) ?? string(root.holdId)
  if (sessionId) next.sessionId = sessionId
  if (revision !== undefined) next.revision = revision
  if (quoteId) next.quoteId = quoteId
  if (requirementsFingerprint) next.requirementsFingerprint = requirementsFingerprint
  if (holdId) next.holdId = holdId
  if (string(session?.state)) next.sessionState = string(session.state)
  if (string(session?.expiresAt)) next.expiresAt = string(session.expiresAt)
  if (string(quote?.expiresAt)) next.quoteExpiresAt = string(quote.expiresAt)
  if (string(hold?.expiresAt)) next.holdExpiresAt = string(hold.expiresAt)
  if (root.kind === "commit_result" && outcome) {
    next.commitOutcome = string(outcome.kind) ?? "unknown"
    const booking = record(outcome.booking)
    if (string(booking?.id)) next.bookingId = string(booking.id)
  }
  if (root.kind === "session_created") {
    next.quoteId = undefined
    next.holdId = undefined
    next.requirementsFingerprint = undefined
    next.commitOutcome = undefined
    next.bookingId = undefined
    next.handoff = undefined
  }
  if (root.kind === "session_abandoned") {
    next.quoteId = undefined
    next.holdId = undefined
    next.requirementsFingerprint = undefined
    next.handoff = undefined
  }
  const handoff = checkoutHandoff(root)
  if (handoff) next.handoff = handoff
  return next
}

function makeIdempotencyKey(action, randomUUID) {
  return `theme-${action}-${randomUUID()}`.slice(0, 128)
}

export function createBookingJourney({
  endpoint,
  checkoutEndpoint,
  productId,
  initialOutcome,
  capability,
  fetchImpl = globalThis.fetch,
  randomUUID = () => globalThis.crypto.randomUUID(),
  origin = globalThis.location?.origin,
}) {
  // This is ephemeral presentation state, not a booking engine or customer
  // account. The managed runtime remains authoritative; a reload intentionally
  // forgets these opaque handles and no identity, payment, or session data is
  // written to browser storage.
  if (capability !== undefined && !/^bcap_[A-Za-z0-9_-]{43,}$/.test(capability)) {
    throw new Error("The managed booking capability is invalid")
  }
  let state = initialOutcome
    ? reduceBookingState(productId ? { productId } : {}, initialOutcome)
    : productId ? { productId } : {}
  const pendingKeys = new Map()
  const storefrontOrigin = origin ? new URL(origin).origin : undefined

  function capabilityEndpoint(value) {
    if (!storefrontOrigin) return value
    const resolved = new URL(value, storefrontOrigin)
    if (resolved.origin !== storefrontOrigin) {
      throw new Error("The managed capability must use this storefront origin")
    }
    return resolved.toString()
  }

  function keyFor(action) {
    const existing = pendingKeys.get(action)
    if (existing) return existing
    const created = makeIdempotencyKey(action, randomUUID)
    pendingKeys.set(action, created)
    return created
  }

  async function perform(action, input = {}) {
    if (!ACTIONS.has(action)) throw new Error("Unsupported booking action")
    const idempotencyKey = keyFor(action)
    let targetEndpoint = endpoint
    let method = "PATCH"
    let body
    if (action === "create") {
      if (!productId) throw new Error("This booking session is already managed")
      method = "POST"
      body = {
        idempotencyKey,
        target: { kind: "product", productId },
        ...(input.selection ? { selection: input.selection } : {}),
      }
    } else if (action === "checkout") {
      if (!checkoutEndpoint) throw new Error("Checkout is not available")
      if (!state.sessionId) throw new Error("Start a booking first")
      targetEndpoint = checkoutEndpoint
      method = "POST"
      body = { sessionId: state.sessionId, method: input.paymentIntent }
    } else {
      if (!state.sessionId || state.revision === undefined) {
        throw new Error("Start a booking first")
      }
      body = {
        sessionId: state.sessionId,
        action,
        revision: state.revision,
        idempotencyKey,
        ...(action === "update" ? { selection: input.selection } : {}),
        ...(action === "hold"
          ? { quoteId: state.quoteId, quantity: input.quantity ?? 1 }
          : {}),
        ...(action === "commit"
          ? {
              quoteId: state.quoteId,
              ...(state.holdId ? { holdId: state.holdId } : {}),
              requirementsFingerprint: state.requirementsFingerprint,
              paymentIntent: input.paymentIntent,
              payment: input.payment,
            }
          : {}),
        ...(action === "renew"
          ? { extendBySeconds: input.extendBySeconds ?? 900 }
          : {}),
      }
    }

    const response = await fetchImpl(capabilityEndpoint(targetEndpoint), {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        ...(capability && targetEndpoint === endpoint
          ? { "Voyant-Booking-Session-Capability": capability }
          : {}),
      },
      body: JSON.stringify(body),
    })
    const payload = await response.json().catch(() => undefined)
    if (!response.ok) {
      const code = string(record(payload)?.error) ?? `request_failed_${response.status}`
      const failure = new Error(readableCode(code))
      failure.status = response.status
      failure.code = code
      throw failure
    }
    if (!record(payload)) throw new Error("The booking service returned an invalid response")
    state = reduceBookingState(state, payload)
    if (action === "checkout") state.lastOutcome = "checkout_ready"
    pendingKeys.delete(action)
    return { payload, state: { ...state } }
  }

  return {
    perform,
    state: () => ({ ...state }),
    retryKey: (action) => pendingKeys.get(action),
  }
}

export function selectionFromForm(form) {
  const data = new FormData(form)
  const departureSlotId = string(data.get("departureSlotId"))
  const adults = Math.max(1, Number.parseInt(String(data.get("adults") ?? "1"), 10) || 1)
  const firstName = string(data.get("firstName"))
  const lastName = string(data.get("lastName"))
  const email = string(data.get("email"))
  const selection = {
    configure: {
      ...(departureSlotId ? { departureSlotId } : {}),
      pax: { adult: adults, child: 0, infant: 0 },
    },
  }
  if (firstName && lastName) {
    selection.travelers = [{ firstName, lastName, band: "adult" }]
  }
  if (firstName || lastName || email) {
    selection.billing = {
      buyerType: "B2C",
      contact: {
        firstName: firstName ?? "",
        lastName: lastName ?? "",
        email: email ?? "",
      },
    }
  }
  return selection
}

export function offeredPaymentIntents(payload) {
  const root = record(payload)
  const quote = record(root?.quote)
  const session = record(root?.session)
  const requirements =
    record(session?.requirements) ??
    record(root?.requirements) ??
    record(quote?.requirements)
  const values = requirements?.paymentIntents
  if (!Array.isArray(values)) return []
  return values.filter((value) => PAYMENT_INTENTS.has(value))
}
