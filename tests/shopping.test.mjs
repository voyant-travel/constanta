import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import {
  capabilityEndpoint,
  createShoppingClient,
  formatPresentationMoney,
  messagesFor,
  ShoppingHttpError,
} from "../src/lib/shopping.mjs"

const AVAILABLE = {
  marketIds: ["ro-public"],
  locales: ["ro-RO", "en-GB"],
  currencies: ["RON", "GBP"],
}

function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function scope(currency = "GBP") {
  return { marketId: "ro-public", locale: "en-GB", currency, available: AVAILABLE }
}

test("uses only an available same-origin managed capability", () => {
  const live = {
    capabilities: [
      { id: "shopping.search.v1", available: false, methods: ["POST"], endpoint: "/wrong" },
      { id: "shopping.search.v1", available: true, methods: ["POST"], endpoint: "/v1/public/theme/shopping/search" },
    ],
  }
  assert.equal(
    capabilityEndpoint(live, "shopping.search.v1", "POST"),
    "/v1/public/theme/shopping/search",
  )
  assert.equal(capabilityEndpoint(live, "shopping.search.v1", "GET"), undefined)
})

test("accepts server-clamped scope and never calculates presentation FX", async () => {
  const calls = []
  const client = createShoppingClient({
    searchEndpoint: "/v1/public/theme/shopping/search",
    tripsEndpoint: "/v1/public/theme/shopping/trip-selections",
    locale: "ro-RO",
    origin: "https://shop.example",
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return response({
        data: {
          kind: "stay",
          scope: scope(),
          offers: [{
            offerRef: "opaque-stay-offer-1234",
            accommodationRef: "opaque-accommodation-1234",
            title: "A quiet room",
            checkIn: "2026-09-01",
            checkOut: "2026-09-03",
            price: {
              native: { amount: "80.00", currency: "EUR" },
              presentation: { amount: "71.25", currency: "GBP" },
              fx: { rate: "0.890625", provider: "voyant-data", quotedAt: "2026-08-09T10:00:00Z" },
            },
          }],
          coverage: { status: "complete", succeeded: 1, failed: 0, timedOut: 0 },
        },
      })
    },
  })

  const result = await client.search({
    kind: "stay",
    destination: { query: "London" },
    checkIn: "2026-09-01",
    checkOut: "2026-09-03",
    rooms: [{ adults: 2 }],
  })

  assert.deepEqual(calls[0].body.scope, { locale: "ro-RO" })
  assert.deepEqual(client.scope(), scope())
  assert.equal(result.offers[0].price.presentation.amount, "71.25")
  assert.match(formatPresentationMoney(result.offers[0].price, "en-GB"), /71\.25/)
  assert.doesNotMatch(formatPresentationMoney(result.offers[0].price, "en-GB"), /80/)
  assert.equal("providerId" in calls[0].body, false)
  assert.equal("connectionId" in calls[0].body, false)
  assert.equal("customerId" in calls[0].body, false)
})

test("accepts live cruise offers and adds only their opaque reference to a Trip", async () => {
  const calls = []
  const client = createShoppingClient({
    searchEndpoint: "/v1/public/theme/shopping/search",
    tripsEndpoint: "/v1/public/theme/shopping/trip-selections",
    locale: "en-GB",
    origin: "https://shop.example",
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body)
      calls.push({ url, method: init.method, body })
      if (url.endsWith("/search")) {
        return response({ data: {
          kind: "cruise",
          scope: scope(),
          offers: [{
            offerRef: "opaque-cruise-offer-1234",
            title: "Danube cities",
            cruiseType: "river",
            lineName: "Voyant River",
            shipName: "Aurora",
            departureDate: "2026-09-12",
            returnDate: "2026-09-19",
            nights: 7,
            cabinName: "Panorama suite",
            availability: "available",
            price: {
              native: { amount: "800.00", currency: "EUR" },
              presentation: { amount: "710.00", currency: "GBP" },
              fx: { rate: "0.8875", provider: "voyant-data", quotedAt: "2026-08-10T07:00:00Z" },
            },
            expiresAt: "2026-08-10T07:15:00Z",
          }],
          coverage: { status: "complete", succeeded: 1, failed: 0, timedOut: 0 },
        } })
      }
      return response({ data: {
        selectionRef: "opaque-selection-ref-cruise",
        revision: 0,
        scope: scope(),
        items: [{ itemRef: "opaque-item-cruise", kind: "cruise", quantity: 1 }],
      } }, 201)
    },
  })

  const result = await client.search({
    kind: "cruise",
    travelers: { adults: 2 },
    cruiseTypes: ["river"],
    limit: 20,
  })
  await client.add("cruise", result.offers[0].offerRef)

  assert.equal(result.offers[0].price.presentation.amount, "710.00")
  assert.deepEqual(calls[1].body.offers, [
    { kind: "cruise", offerRef: "opaque-cruise-offer-1234" },
  ])
  assert.doesNotMatch(JSON.stringify(calls), /connectionId|providerId|sourceRef/)
})

test("rejects money that is not in the server-resolved presentation currency", async () => {
  const client = createShoppingClient({
    searchEndpoint: "/search",
    locale: "en-GB",
    origin: "https://shop.example",
    fetchImpl: async () => response({ data: {
      kind: "flight",
      scope: scope("GBP"),
      offers: [{
        offerRef: "opaque-flight-offer-1234",
        itineraries: [{ segments: [{
          origin: { code: "OTP", at: "2026-09-01T08:00:00+03:00" },
          destination: { code: "LHR", at: "2026-09-01T09:30:00+01:00" },
          marketingCarrier: "RO",
          flightNumber: "391",
        }] }],
        price: {
          native: { amount: "100", currency: "EUR" },
          presentation: { amount: "100", currency: "EUR" },
        },
      }],
      coverage: { status: "complete", succeeded: 1, failed: 0, timedOut: 0 },
    } }),
  })
  await assert.rejects(client.search({ kind: "flight" }), /outside the resolved currency/)
})

test("creates and mutates one opaque Trip with compare-and-swap revisions", async () => {
  const calls = []
  const trip = (revision, itemRefs) => ({ data: {
    selectionRef: "opaque-selection-ref-1234",
    revision,
    scope: scope(),
    items: itemRefs.map((itemRef, index) => ({
      itemRef,
      kind: index === 0 ? "flight" : "stay",
      quantity: 1,
    })),
  } })
  const replies = [
    trip(0, ["opaque-item-flight-1234"]),
    trip(1, ["opaque-item-flight-1234", "opaque-item-stay-12345"]),
    trip(2, ["opaque-item-stay-12345", "opaque-item-flight-1234"]),
    trip(3, ["opaque-item-stay-12345"]),
  ]
  const client = createShoppingClient({
    searchEndpoint: "/search",
    tripsEndpoint: "/trips",
    locale: "en-GB",
    origin: "https://shop.example",
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, body: JSON.parse(init.body) })
      return response(replies.shift(), init.method === "POST" ? 201 : 200)
    },
  })

  await client.add("flight", "opaque-flight-offer-1234")
  await client.add("stay", "opaque-stay-offer-12345")
  await client.reorder(["opaque-item-stay-12345", "opaque-item-flight-1234"])
  await client.remove("opaque-item-flight-1234")

  assert.deepEqual(calls.map(({ method }) => method), ["POST", "PATCH", "PATCH", "PATCH"])
  assert.deepEqual(calls[0].body, {
    scope: { locale: "en-GB" },
    offers: [{ kind: "flight", offerRef: "opaque-flight-offer-1234" }],
  })
  assert.deepEqual(calls.slice(1).map(({ body }) => body.expectedRevision), [0, 1, 2])
  assert.equal(client.trip().revision, 3)
  assert.equal(calls.some(({ body }) => "providerId" in body || "bookingId" in body), false)
})

test("serializes concurrent adds so only one Trip is created and later adds use its revision", async () => {
  const calls = []
  let releaseCreate
  const createGate = new Promise((resolve) => { releaseCreate = resolve })
  const client = createShoppingClient({
    tripsEndpoint: "/trips",
    locale: "en-GB",
    origin: "https://shop.example",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body)
      calls.push({ method: init.method, body })
      if (init.method === "POST") {
        await createGate
        return response({ data: {
          selectionRef: "opaque-selection-ref-1234", revision: 0, scope: scope(),
          items: [{ itemRef: "opaque-item-flight-1234", kind: "flight", quantity: 1 }],
        } }, 201)
      }
      return response({ data: {
        selectionRef: "opaque-selection-ref-1234", revision: 1, scope: scope(),
        items: [
          { itemRef: "opaque-item-flight-1234", kind: "flight", quantity: 1 },
          { itemRef: "opaque-item-stay-12345", kind: "stay", quantity: 1 },
        ],
      } })
    },
  })

  const first = client.add("flight", "opaque-flight-offer-1234")
  const second = client.add("stay", "opaque-stay-offer-12345")
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.length, 1)
  releaseCreate()
  await Promise.all([first, second])

  assert.deepEqual(calls.map(({ method }) => method), ["POST", "PATCH"])
  assert.equal(calls[1].body.selectionRef, "opaque-selection-ref-1234")
  assert.equal(calls[1].body.expectedRevision, 0)
  assert.equal(client.trip().revision, 1)
})

test("does not let a delayed search response revert a newer scope choice", async () => {
  let releaseSearch
  const gate = new Promise((resolve) => { releaseSearch = resolve })
  const requestedScopes = []
  const client = createShoppingClient({
    searchEndpoint: "/search",
    locale: "en-GB",
    origin: "https://shop.example",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body)
      requestedScopes.push(body.scope)
      if (requestedScopes.length === 1) await gate
      return response({ data: {
        kind: "indexed-inspiration",
        scope: requestedScopes.length === 1 ? scope("GBP") : {
          ...scope("RON"), locale: "ro-RO",
        },
        groups: [], coverage: { status: "complete", succeeded: 1, failed: 0, timedOut: 0 },
      } })
    },
  })

  const stale = client.search({ kind: "indexed-inspiration", groups: [] })
  client.chooseScope({ locale: "ro-RO", currency: "RON" })
  releaseSearch()
  await stale
  assert.deepEqual(client.scope(), { locale: "ro-RO", currency: "RON" })
  await client.search({ kind: "indexed-inspiration", groups: [] })
  assert.deepEqual(requestedScopes, [
    { locale: "en-GB" },
    { locale: "ro-RO", currency: "RON" },
  ])
})

test("drops a server-resolved market when the shopper changes locale or currency", async () => {
  const requestedScopes = []
  const client = createShoppingClient({
    searchEndpoint: "/search",
    locale: "en",
    origin: "https://shop.example",
    fetchImpl: async (_url, init) => {
      requestedScopes.push(JSON.parse(init.body).scope)
      return response({ data: {
        kind: "indexed-inspiration",
        scope: scope("GBP"),
        groups: [],
        coverage: { status: "complete", succeeded: 1, failed: 0, timedOut: 0 },
      } })
    },
  })

  await client.search({ kind: "indexed-inspiration", groups: [] })
  assert.equal(client.scope().marketId, "ro-public")

  client.chooseScope({ locale: "ro-RO", currency: "RON" })
  await client.search({ kind: "indexed-inspiration", groups: [] })

  assert.deepEqual(requestedScopes, [
    { locale: "en" },
    { locale: "ro-RO", currency: "RON" },
  ])
})

test("fails closed on a CAS conflict instead of replaying a stale mutation", async () => {
  let calls = 0
  const client = createShoppingClient({
    searchEndpoint: "/search",
    tripsEndpoint: "/trips",
    locale: "en",
    origin: "https://shop.example",
    fetchImpl: async (_url, init) => {
      calls += 1
      if (calls === 1) return response({ data: {
        selectionRef: "opaque-selection-ref-1234",
        revision: 0,
        scope: scope(),
        items: [{ itemRef: "opaque-item-flight-1234", kind: "flight", quantity: 1 }],
      } }, 201)
      assert.equal(init.method, "PATCH")
      return response({ error: "trip_selection_revision_conflict" }, 409)
    },
  })
  await client.add("flight", "opaque-flight-offer-1234")
  await assert.rejects(client.remove("opaque-item-flight-1234"), (error) => {
    assert.ok(error instanceof ShoppingHttpError)
    assert.equal(error.status, 409)
    return true
  })
  assert.equal(client.trip(), undefined)
  assert.equal(calls, 2)
})

test("books the exact Trip revision and reuses one idempotency key after transport failure", async () => {
  const calls = []
  let attempt = 0
  const client = createShoppingClient({
    tripsEndpoint: "/trips",
    bookEndpoint: "/trips/book",
    locale: "en-GB",
    origin: "https://shop.example",
    randomUUID: () => "00000000-0000-4000-8000-000000000001",
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body)
      calls.push({ url, method: init.method, body })
      if (url.endsWith("/trips")) return response({ data: {
        selectionRef: "opaque-selection-ref-1234",
        revision: 7,
        scope: scope(),
        items: [{ itemRef: "opaque-item-flight-1234", kind: "flight", quantity: 1 }],
      } }, 201)
      attempt += 1
      if (attempt === 1) throw new TypeError("network unavailable")
      return response({ data: {
        bookingSessionCapability: `bcap_${"a".repeat(43)}`,
        outcome: {
          kind: "session_created",
          session: {
            id: "bses_trip_1",
            revision: 1,
            target: { kind: "managed_itinerary" },
          },
        },
      } })
    },
  })

  await client.add("flight", "opaque-flight-offer-1234")
  await assert.rejects(client.book(), /network unavailable/)
  const retryKey = client.bookRetryKey()
  const booked = await client.book()

  assert.equal(calls[1].body.idempotencyKey, calls[2].body.idempotencyKey)
  assert.equal(calls[1].body.idempotencyKey, retryKey)
  assert.deepEqual(calls[1].body, {
    selectionRef: "opaque-selection-ref-1234",
    expectedRevision: 7,
    idempotencyKey: "theme-book-itinerary-00000000-0000-4000-8000-000000000001",
  })
  assert.equal(booked.outcome.session.target.kind, "managed_itinerary")
  assert.equal(client.bookRetryKey(), undefined)
  await assert.rejects(
    client.add("stay", "opaque-stay-offer-after-booking"),
    /already been booked/,
  )
})

test("disables every result-card Trip mutation after booking succeeds", async () => {
  const source = await readFile(new URL("../src/lib/shopping-ui.mjs", import.meta.url), "utf8")
  assert.match(source, /button\.dataset\.addToTrip = ""/)
  assert.match(source, /Boolean\(container\.dataset\.tripsEndpoint\) && !client\.booking\(\)/)
  assert.match(source, /for \(const button of root\.querySelectorAll\("\[data-add-to-trip\]"\)\)/)
  assert.match(source, /const booking = await client\.book\(\)\s+disableResultMutations\(root\)/)
})

test("sends a deterministic city destination to managed package search", async () => {
  const source = await readFile(
    new URL("../src/lib/shopping.mjs", import.meta.url),
    "utf8",
  )
  assert.match(
    source,
    /kind: "package",[\s\S]*destination: \{ city: text\(form, "packageDestination"\) \}/,
  )
  assert.doesNotMatch(
    source,
    /kind: "package",[\s\S]*destination: \{ query: text\(form, "packageDestination"\) \}/,
  )
})

test("sends a deterministic city destination to managed stay search", async () => {
  const source = await readFile(
    new URL("../src/lib/shopping.mjs", import.meta.url),
    "utf8",
  )
  assert.match(
    source,
    /if \(kind === "stay"\)[\s\S]*destination: \{ city: text\(form, "stayDestination"\) \}/,
  )
  assert.doesNotMatch(
    source,
    /if \(kind === "stay"\)[\s\S]*destination: \{ query: text\(form, "stayDestination"\) \}/,
  )
})

test("builds provider-neutral cruise intent and renders cruise result details", async () => {
  const shopping = await readFile(
    new URL("../src/lib/shopping.mjs", import.meta.url),
    "utf8",
  )
  const ui = await readFile(
    new URL("../src/lib/shopping-ui.mjs", import.meta.url),
    "utf8",
  )
  assert.match(shopping, /if \(kind === "cruise"\)[\s\S]*travelers:[\s\S]*cruiseTypes/)
  assert.match(shopping, /"indexed-inspiration", "flight", "stay", "package", "cruise"/)
  assert.match(ui, /row\.lineName,[\s\S]*row\.shipName,[\s\S]*row\.cabinName/)
  assert.doesNotMatch(shopping, /connectionId|providerId|sourceRef/)
})

test("fails closed when a Trip booking capability is stale or expired", async () => {
  for (const status of [403, 409]) {
    let calls = 0
    const client = createShoppingClient({
      tripsEndpoint: "/trips",
      bookEndpoint: "/trips/book",
      locale: "en-GB",
      origin: "https://shop.example",
      randomUUID: () => "00000000-0000-4000-8000-000000000001",
      fetchImpl: async () => {
        calls += 1
        if (calls === 1) return response({ data: {
          selectionRef: "opaque-selection-ref-1234",
          revision: 2,
          scope: scope(),
          items: [{ itemRef: "opaque-item-stay-1234", kind: "stay", quantity: 1 }],
        } }, 201)
        return response({ error: status === 409
          ? "trip_selection_revision_conflict"
          : "storefront_trip_selection_not_found" }, status)
      },
    })
    await client.add("stay", "opaque-stay-offer-1234")
    await assert.rejects(client.book(), (error) => {
      assert.ok(error instanceof ShoppingHttpError)
      assert.equal(error.status, status)
      return true
    })
    assert.equal(client.trip(), undefined)
    assert.equal(client.bookRetryKey(), undefined)
  }
})

test("keeps an unpriced Trip retryable without changing its exact request", async () => {
  const bodies = []
  let calls = 0
  const client = createShoppingClient({
    tripsEndpoint: "/trips",
    bookEndpoint: "/trips/book",
    locale: "en-GB",
    origin: "https://shop.example",
    randomUUID: () => "00000000-0000-4000-8000-000000000001",
    fetchImpl: async (_url, init) => {
      calls += 1
      const body = JSON.parse(init.body)
      if (calls === 1) return response({ data: {
        selectionRef: "opaque-selection-ref-1234",
        revision: 4,
        scope: scope(),
        items: [{ itemRef: "opaque-item-product-1234", kind: "product", quantity: 1 }],
      } }, 201)
      bodies.push(body)
      return response({ error: "storefront_trip_booking_pricing_unavailable" }, 400)
    },
  })
  await client.add("product", "opaque-product-offer-1234")
  await assert.rejects(client.book())
  await assert.rejects(client.book())
  assert.ok(client.trip())
  assert.deepEqual(bodies[0], bodies[1])
})

test("refuses a provider-origin endpoint and keeps authority on the storefront", async () => {
  let called = false
  const client = createShoppingClient({
    searchEndpoint: "https://provider.example/search",
    locale: "en",
    origin: "https://shop.example",
    fetchImpl: async () => {
      called = true
      return response({})
    },
  })
  await assert.rejects(client.search({ kind: "indexed-inspiration", groups: [] }), /storefront origin/)
  assert.equal(called, false)
})

test("localizes common operator languages and falls back without changing result locale", () => {
  assert.equal(messagesFor("ro-RO").search, "Caută")
  assert.equal(messagesFor("fr-FR").tripHeading, "Votre voyage")
  assert.equal(messagesFor("ja-JP").search, "Search")
})

test("gives the global locale and currency controls stable form identities", async () => {
  const source = await readFile(
    new URL("../src/components/ShoppingExperience.astro", import.meta.url),
    "utf8",
  )
  assert.match(source, /id="shopping-locale" name="shoppingLocale"/)
  assert.match(source, /id="shopping-currency" name="shoppingCurrency"/)
})

test("resolves each scope-picker change without stale market preferences", async () => {
  const source = await readFile(new URL("../src/lib/shopping-ui.mjs", import.meta.url), "utf8")
  assert.match(source, /client\.chooseScope\(\{ locale: localeControl\.value \}\)/)
  assert.match(source, /client\.chooseScope\(\{ currency: currencyControl\.value \}\)/)
  assert.doesNotMatch(
    source,
    /client\.chooseScope\(\{ locale: localeControl\.value, currency: currencyControl\.value \}\)/,
  )
})

test("declares the published managed shopping capability routes", async () => {
  const source = await readFile(new URL("../theme.config.ts", import.meta.url), "utf8")
  assert.match(source, /\{ id: "shopping\.search\.v1" \}/)
  assert.match(source, /\{ id: "shopping\.trip-selections\.v1" \}/)
  assert.match(source, /\{ id: "shopping\.trip-booking\.v1" \}/)
  assert.match(source, /endpoint: "\/v1\/public\/theme\/shopping\/search"/)
  assert.match(source, /endpoint: "\/v1\/public\/theme\/shopping\/trip-selections"/)
  assert.match(source, /endpoint: "\/v1\/public\/theme\/shopping\/trip-selections\/book"/)
  assert.match(source, /\{ id: "cruise\.search\.v1" \}/)
  assert.match(source, /pattern: "\/cruises"/)
  assert.match(source, /pattern: "\/ships\/\[slug\]"/)
  assert.match(source, /pattern: "\/sailings\/\[slug\]"/)
})

test("keeps the theme locale-agnostic for operator-configured languages", async () => {
  const source = await readFile(new URL("../theme.config.ts", import.meta.url), "utf8")
  assert.equal([...source.matchAll(/locale: "und"/g)].length, 9)
  assert.doesNotMatch(source, /locale: "en"/)
})

test("browser code has no account, payment, provider selector, FX math, or opaque-ref persistence", async () => {
  const source = await readFile(new URL("../src/lib/shopping.mjs", import.meta.url), "utf8")
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie|indexedDB/)
  assert.doesNotMatch(source, /providerId|connectionId|paymentMethod|customerAccount|login/)
  assert.doesNotMatch(source, /fx\.rate|native\.amount/)
})
