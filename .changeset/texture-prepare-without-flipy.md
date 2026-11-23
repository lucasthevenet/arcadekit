---
"@arcadekit/three": minor
---

`Three.texture`'s `prepare` is handed the texture without its `flipY`, so setting it there no longer compiles. It used to compile and fail the load, since Three.js does not read `flipY` of a texture made of a bitmap.

**Breaking**

- `prepare` takes an `Omit<Texture, "flipY">`. A game that set `texture.flipY` in `prepare` passes `Three.texture(url, { flipY })` instead, and a `prepare` written as a function of a whole `Texture` takes the narrower type.
