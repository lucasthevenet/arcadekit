---
"arcadekit": minor
---

In a page, `Browser.runMain` and `Browser.layer` read an asset's path against the document's base, its `<base href>`, as `fetch` does, where Effect's `HttpClient` read it against the page's address. A loader of the game's own, provided around the layer, is kept.

**Breaking**

- A page with a `<base href>` loads its assets from where the base says. A game that set a base and relied on paths read from the page's address writes those paths from the base, or as absolute URLs.
