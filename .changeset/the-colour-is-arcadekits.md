---
"arcadekit": minor
"@arcadekit/three": minor
---

What colour an entity is drawn in is arcadekit's, as where it is drawn is: `arcadekit/Color` gives one component, `Color.Rgb`, of three 32-bit floats and the `space` they are written in, `Color.Srgb`, as a hex code writes a colour, from 0 to 1, or `Color.Linear`, a renderer's own numbers, over 1 for a colour brighter than white. It is white when added bare. `Three.instances(name, { ..., color: Color.Rgb })` draws each entity by the space of its own colour, so entities of one kind can have either. A component of the game's own does not compile as `color`, so neither one of mixed kinds of field nor one of bytes can be passed.

**Breaking**

- `Three.instances` no longer takes a colour component of the game's. A game that wrote `const Paint = Component.define("game/Paint", { r: Field.f32, g: Field.f32, b: Field.f32 })` and `color: Paint` spawns `Color.Rgb.of({ r, g, b, space: Color.Srgb })` and writes `color: Color.Rgb`.
- `colorSpace` is removed. A game that wrote `colorSpace: "srgb-linear"` gives its entities colours whose `space` is `Color.Linear`.
- A colour in bytes, fields of `Field.u8`, is no longer read. A game that held `{ r: 0xff, g: 0x61, b: 0x88 }` writes `Color.Rgb.of({ r: 0xff / 255, g: 0x61 / 255, b: 0x88 / 255, space: Color.Srgb })`.
- `Three.ColorComponent` is removed.
- The two refusals when the system was made, of a component that is no colour and of one whose fields are of mixed kinds, are gone, since neither can be written. A number below 0 or over 1 in `Color.Srgb` still fails the frame, naming the entity, and so does a `space` that is neither.

Nothing breaks in `arcadekit`: `Color` is new.
