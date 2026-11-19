---
"arcadekit": patch
"@arcadekit/three": patch
---

The build writes each source file to a file of its own in `dist/`, `dist/ecs/world.js` for `src/ecs/world.ts`, in place of chunks shared between entries. An entry now loads only the modules it reaches, and imports only the packages they import.

Nothing breaks: the entries, and what each one gives, are the same.
