---
"arcadekit": minor
---

What only a page can use is a folder, `src/browser/`. `arcadekit/Browser` is its `Browser.ts`, and the page's sound is a module of its own beside it, `arcadekit/browser/Audio`: `Audio.layerSound`, `Audio.stream`, `Audio.sound`, `Audio.AudioLike` and `Audio.MediaLike`. What both keep to themselves is in `src/browser/internals/`, which is no entry.

Nothing breaks: `arcadekit/Browser` exports the same names, with the same types and doc comments, the page's sound among them, and does what it did. `arcadekit/browser/Audio` only adds an entry.
