# Constanța

Voyant's itinerary-first coastal storefront theme. Constanța deliberately uses
a navigation rail, operational voyage boards, and horizontal day-by-day routes
rather than Bucharest's editorial page and card language. Both themes consume
the same versioned tour, cruise, managed-shopping, Trip, and Book-all contract.

## Develop

```sh
npm install
npm run dev
```

`npm run dev` serves the fixtures declared in `theme.config.ts`. A published
site resolves page context from an immutable publication snapshot instead,
through the same `resolveThemeContext` call.

The `/tours` and `/tours/:slug` fixtures demonstrate the v1alpha4 split:
editorial product identity and presentation are immutable page context, while
search, dates, prices, booking sessions, and checkout use platform-generated
same-origin capabilities. No provider endpoint or credential reaches the theme.

Constanța is presentation-only. Its booking controls retain opaque session and
revision handles in memory for the current page attempt, then hand payment and
account journeys to managed platform capabilities. The theme does not persist
customer identity, profiles, booking or payment state, and it does not call an
engine or provider API directly.

On the home page, an operator-enabled `shopping.trip-booking.v1` capability can
freeze the exact opaque Trip revision into one managed itinerary Booking
Session. Constanța submits only the selection capability, expected revision,
and a retry-stable idempotency key, then reuses `booking.session.v1` and
`checkout.v1` for quote, hold, commit, and secure checkout. It never receives
Trip, provider, source, connection, payment, or FX authority.

## Validate

```sh
npm run theme:check   # contract and fixture diagnostics
npm run build         # validates, then builds the Worker entrypoint
```

## Build shape

`astro.config.mjs` sets `output: "server"` with the Cloudflare adapter because
the theme must emit `dist/server/entry.mjs`. A fully prerendered build emits no
server entrypoint and `voyant theme build` rejects the artifact.

`package-lock.json` is committed deliberately: the platform build lane detects
the package manager from the lockfile and installs with a frozen lockfile, so a
theme without one cannot be built.

## Publishing

Constanța is published to the Voyant theme catalog as a public theme, so every
operator can select it without connecting a repository of their own. Git is the
theme author's concern, not the operator's.

## Version pinning

`@voyant-travel/theme` is pinned to an exact version, not a range. The platform
build lane selects one SDK version and rejects any theme that does not pin the
same one, because a range would let two builds of the same commit resolve
different SDKs. Bump it deliberately, in step with the platform.

Do not add `@voyant-travel/cli` as a dependency. The lane supplies its own
pinned copy, and depending on it pulls the operator runtime into the theme.

The lane verifies the uploaded artifact against its recorded size.

Artifacts are verified against their recorded size and digest.

Build evidence is written alongside the artifact.

The build lane records provenance for every release.

Releases are immutable once recorded.

A release records the exact commit, SDK and artifact digest.

The publish lane deploys each release into the dispatch namespaces.

Each release is deployed under the same worker name in both namespaces.
