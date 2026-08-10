// @ts-check
import cloudflare from "@astrojs/cloudflare"
import { voyantTheme } from "@voyant-travel/astro"
import { defineConfig } from "astro/config"
import theme from "./theme.config.ts"

// Voyant serves every route from a Cloudflare Worker and resolves page context
// per request, so this builds a server entrypoint rather than prerendering. A
// fully prerendered build emits no `server/entry.mjs` and `voyant theme build`
// rejects the artifact.
export default defineConfig({
  output: "server",
  adapter: cloudflare(),
  integrations: [voyantTheme({ theme })],
})
