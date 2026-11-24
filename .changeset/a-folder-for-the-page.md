---
"arcadekit": patch
---

`src/Browser.ts` is split by what it does into files of `src/browser/`, behind the same entry: the options and the models they take, the devices, the page's audio, and the sounds and pictures a game makes. The build writes them to `dist/browser/`.

Nothing breaks: `arcadekit/Browser` exports the same names, with the same types and doc comments, and does what it did.
