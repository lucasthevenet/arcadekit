---
"arcadekit": patch
---

`src/Browser.ts` keeps what `arcadekit/Browser` exports, each with its type and doc comment, and the code behind them moves to `src/browser/internal/`: the page's display and layer, the devices, the page's audio, and the sounds and pictures it decodes. The build writes them to `dist/browser/internal/`.

Nothing breaks: `arcadekit/Browser` exports the same names, with the same types and doc comments, and does what it did.
