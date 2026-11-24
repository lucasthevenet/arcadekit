---
"arcadekit": minor
---

What only a page can use is laid out as Effect 4.1.4 lays out a folder of modules, as `arcadekit/net` is: `arcadekit/browser` gives its modules as namespaces, `import { Browser, Audio } from "arcadekit/browser"`, and each module is an entry of its own at its path, `arcadekit/browser/Browser` and `arcadekit/browser/Audio`. What they keep to themselves is in `src/browser/internal/`. Part of #265.

What breaks:

- The entry `arcadekit/Browser` is gone. Import `{ Browser }` from `arcadekit/browser`, or `* as Browser` from `arcadekit/browser/Browser`. `Browser` exports the same names as before, the page's sound among them, so `Browser.runMain`, `Browser.layer`, `Browser.image` and `Browser.layerSound` are written as they were.
