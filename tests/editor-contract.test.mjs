import assert from "node:assert/strict"
import test from "node:test"
import { injectThemeEditorBridge } from "@voyant-travel/astro"
import {
  decodeStega,
  encodeThemeContextProvenance,
  getThemeEditorContext,
} from "@voyant-travel/theme"

function context(editor) {
  return {
    kind: "home",
    path: "/",
    locale: "en",
    site: { name: "Bucharest" },
    navigation: [],
    settings: {},
    title: "Bucharest",
    seo: { title: "Bucharest" },
    sections: [
      {
        type: "hero",
        data: {
          id: "hero-one",
          settings: { heading: "Travel further" },
          blocks: [],
        },
      },
    ],
    ...(editor ? { _voyant: editor } : {}),
  }
}

function renderHeading(pageContext) {
  const heading = pageContext.sections[0].data.settings.heading
  return `<!doctype html><html><body><main><section><h1>${heading}</h1></section></main></body></html>`
}

test("a published context has neither editor bridge nor editor attributes", () => {
  const published = encodeThemeContextProvenance(context())
  const html = injectThemeEditorBridge(
    renderHeading(published),
    getThemeEditorContext(published),
  )

  assert.equal(html.includes("voyant-editor-bridge"), false)
  assert.equal(html.includes("data-voyant-"), false)
  assert.match(html, /<h1>Travel further<\/h1>/)
})

test("a draft context keeps selectable stega text and receives the bridge", () => {
  const draft = encodeThemeContextProvenance(
    context({
      mode: "draft",
      editorOrigin: "https://app.voyant.travel",
    }),
  )
  const heading = draft.sections[0].data.settings.heading

  assert.deepEqual(decodeStega(heading), {
    value: "Travel further",
    pointer: "/sections/0/data/settings/heading",
  })

  const html = injectThemeEditorBridge(
    renderHeading(draft),
    getThemeEditorContext(draft),
  )
  assert.match(html, /<h1>Travel further[^<]+<\/h1>/)
  assert.match(html, /id="voyant-editor-bridge"/)
  assert.match(html, /voyant:edit:select/)
  assert.equal(html.includes("data-voyant-"), false)
})
