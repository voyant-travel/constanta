import assert from "node:assert/strict"
import test from "node:test"
import {
  checkoutHandoff,
  createBookingJourney,
  reduceBookingState,
} from "../src/lib/booking-journey.mjs"

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

test("runs the closed booking session action envelope with advanced revisions", async () => {
  const calls = []
  const replies = [
    { kind: "session_created", session: { id: "bses_1", revision: 1, state: "active" } },
    { kind: "session_updated", session: { id: "bses_1", revision: 2, state: "active" } },
    {
      kind: "quote_created",
      session: { id: "bses_1", revision: 3, state: "active" },
      quote: { id: "bqte_1", requirementsFingerprint: "rqf_1" },
    },
    {
      kind: "hold_created",
      session: { id: "bses_1", revision: 4, state: "active" },
      hold: { id: "bhld_1" },
    },
    { kind: "session_renewed", session: { id: "bses_1", revision: 5, state: "active" } },
    {
      kind: "commit_result",
      outcome: {
        kind: "payment_required",
        paymentSession: {
          checkout: { kind: "redirect", url: "https://pay.example/continue" },
        },
      },
    },
  ]
  const journey = createBookingJourney({
    endpoint: "/v1/public/theme/booking/session",
    checkoutEndpoint: "/v1/public/theme/checkout",
    productId: "prod_1",
    randomUUID: () => "00000000-0000-4000-8000-000000000001",
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, body: JSON.parse(init.body) })
      return response(replies.shift())
    },
  })

  const selection = { configure: { departureSlotId: "slot_1", pax: { adult: 2, child: 0, infant: 0 } } }
  await journey.perform("create", { selection })
  await journey.perform("update", { selection })
  await journey.perform("quote")
  await journey.perform("hold", { quantity: 2 })
  await journey.perform("renew", { extendBySeconds: 600 })
  const committed = await journey.perform("commit", {
    paymentIntent: "card",
    payment: { returnUrl: "https://theme.example/tour?checkout=return", acceptedCheckoutHandoffs: ["redirect"] },
  })

  assert.equal(calls[0].method, "POST")
  assert.deepEqual(calls[0].body.target, { kind: "product", productId: "prod_1" })
  assert.deepEqual(calls.slice(1).map((call) => [call.body.action, call.body.revision]), [
    ["update", 1], ["quote", 2], ["hold", 3], ["renew", 4], ["commit", 5],
  ])
  assert.equal(calls[3].body.quoteId, "bqte_1")
  assert.equal(calls[5].body.holdId, "bhld_1")
  assert.equal(calls[5].body.requirementsFingerprint, "rqf_1")
  assert.deepEqual(committed.state.handoff, { kind: "redirect", url: "https://pay.example/continue" })
  for (const call of calls) {
    assert.equal("path" in call.body, false)
    assert.equal("provider" in call.body, false)
    assert.equal("secret" in call.body, false)
  }
  assert.ok(calls.every((call) => call.method === "POST" || call.method === "PATCH"))
})

test("keeps an idempotency key after a transport failure and rotates it after success", async () => {
  const keys = []
  let attempt = 0
  const journey = createBookingJourney({
    endpoint: "/booking",
    productId: "prod_1",
    randomUUID: () => `00000000-0000-4000-8000-00000000000${attempt + 1}`,
    fetchImpl: async (_url, init) => {
      keys.push(JSON.parse(init.body).idempotencyKey)
      attempt += 1
      if (attempt === 1) throw new TypeError("network unavailable")
      return response({ kind: "session_created", session: { id: "bses_1", revision: 1 } })
    },
  })
  await assert.rejects(journey.perform("create"), /network unavailable/)
  await journey.perform("create")
  assert.equal(keys[0], keys[1])
})

test("adopts a managed itinerary session and presents its ephemeral capability", async () => {
  const calls = []
  const capability = `bcap_${"a".repeat(43)}`
  const journey = createBookingJourney({
    endpoint: "/booking",
    initialOutcome: {
      kind: "session_created",
      session: {
        id: "bses_itinerary_1",
        revision: 1,
        state: "active",
        target: { kind: "managed_itinerary" },
      },
    },
    capability,
    randomUUID: () => "00000000-0000-4000-8000-000000000001",
    fetchImpl: async (url, init) => {
      calls.push({ url, headers: new Headers(init.headers), body: JSON.parse(init.body) })
      return response({
        kind: "quote_created",
        session: { id: "bses_itinerary_1", revision: 2, state: "active" },
        quote: { id: "bqte_trip_1", requirementsFingerprint: "rqf_trip_1" },
      })
    },
  })

  assert.equal(journey.state().sessionId, "bses_itinerary_1")
  await journey.perform("quote")
  assert.equal(calls[0].headers.get("voyant-booking-session-capability"), capability)
  assert.deepEqual(calls[0].body, {
    sessionId: "bses_itinerary_1",
    action: "quote",
    revision: 1,
    idempotencyKey: "theme-quote-00000000-0000-4000-8000-000000000001",
  })
  assert.equal("selectionRef" in calls[0].body, false)
})

test("refuses a malformed itinerary booking capability before making a request", () => {
  assert.throws(() => createBookingJourney({
    endpoint: "/booking",
    initialOutcome: { kind: "session_created", session: { id: "bses_1", revision: 1 } },
    capability: "bcap_short",
  }), /capability is invalid/)
})

test("hands a payment-required session to the managed checkout capability", async () => {
  const calls = []
  const replies = [
    { kind: "session_created", session: { id: "bses_1", revision: 1 } },
    {
      kind: "quote_created",
      session: { id: "bses_1", revision: 2 },
      quote: { id: "bqte_1", requirementsFingerprint: "rqf_1" },
    },
    { kind: "commit_result", outcome: { kind: "payment_required" } },
    { redirectUrl: "https://checkout.example/managed" },
  ]
  const journey = createBookingJourney({
    endpoint: "/booking",
    checkoutEndpoint: "/checkout",
    productId: "prod_1",
    randomUUID: () => "00000000-0000-4000-8000-000000000001",
    fetchImpl: async (url, init) => {
      calls.push({ url, headers: new Headers(init.headers), body: JSON.parse(init.body) })
      return response(replies.shift())
    },
  })
  await journey.perform("create")
  await journey.perform("quote")
  await journey.perform("commit", { paymentIntent: "card" })
  const result = await journey.perform("checkout", { paymentIntent: "card" })

  assert.deepEqual(calls[3].body, { sessionId: "bses_1", method: "card" })
  assert.match(calls[3].headers.get("idempotency-key"), /^theme-checkout-/)
  assert.deepEqual(result.state.handoff, {
    kind: "redirect",
    url: "https://checkout.example/managed",
  })
  assert.equal(result.state.lastOutcome, "checkout_ready")
})

test("surfaces capability errors without advancing managed state", async () => {
  const journey = createBookingJourney({
    endpoint: "/booking",
    productId: "prod_1",
    randomUUID: () => "00000000-0000-4000-8000-000000000001",
    fetchImpl: async () => response({ error: "selling_runtime_unavailable" }, 503),
  })
  await assert.rejects(journey.perform("create"), (error) => {
    assert.equal(error.code, "selling_runtime_unavailable")
    assert.equal(error.status, 503)
    return true
  })
  assert.deepEqual(journey.state(), { productId: "prod_1" })
  assert.match(journey.retryKey("create"), /^theme-create-/)
})

test("repairs the known revision after a conflict without replaying the action", () => {
  const state = reduceBookingState(
    { productId: "prod_1", sessionId: "bses_1", revision: 2 },
    { kind: "rejected", error: { kind: "revision_conflict", actualRevision: 4 } },
  )
  assert.equal(state.revision, 4)
  assert.equal(state.rejection, "revision_conflict")
})

test("starts a clean in-memory attempt after a terminal outcome", () => {
  const state = reduceBookingState(
    {
      productId: "prod_1",
      sessionId: "bses_old",
      revision: 4,
      commitOutcome: "committed",
      bookingId: "bkg_old",
      quoteId: "bqte_old",
      handoff: { kind: "redirect", url: "https://checkout.example/old" },
    },
    { kind: "session_created", session: { id: "bses_new", revision: 1, state: "active" } },
  )
  assert.equal(state.sessionId, "bses_new")
  assert.equal(state.commitOutcome, undefined)
  assert.equal(state.quoteId, undefined)
  assert.equal(state.handoff, undefined)
})

test("accepts only credential-free secure checkout handoffs", () => {
  assert.equal(checkoutHandoff({ redirectUrl: "javascript:alert(1)" }), undefined)
  assert.equal(checkoutHandoff({ redirectUrl: "https://user:pass@pay.example" }), undefined)
  assert.equal(checkoutHandoff({ redirectUrl: "http://pay.example/next" }), undefined)
  assert.deepEqual(checkoutHandoff({ redirectUrl: "https://pay.example/next" }), {
    kind: "redirect",
    url: "https://pay.example/next",
  })
})

test("refuses a capability endpoint outside the storefront origin", async () => {
  let called = false
  const journey = createBookingJourney({
    endpoint: "https://provider.example/booking",
    origin: "https://theme.example",
    productId: "prod_1",
    fetchImpl: async () => {
      called = true
      return response({})
    },
  })
  await assert.rejects(journey.perform("create"), /storefront origin/)
  assert.equal(called, false)
})

test("keeps managed-runtime handles in memory and never uses browser persistence", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/lib/booking-journey.mjs", import.meta.url), "utf8"),
  )
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie|indexedDB/)
})
