---
"arcadekit": minor
"@arcadekit/three": minor
---

What colour an entity is drawn in is arcadekit's, as where it is drawn is: `arcadekit/Color` gives two components of three 32-bit floats, `Color.Srgb`, a colour as a hex code writes it, from 0 to 1, and `Color.Linear`, a renderer's own numbers. Either is white when added bare. `Three.instances(name, { ..., color })` takes only one of the two, and which of them it is says how its numbers are drawn: a component of the game's own does not compile as `color`, so neither one of mixed kinds of field nor one of bytes can be passed.

**Breaking**

- `Three.instances` no longer takes a colour component of the game's. A game that wrote `const Paint = Component.define("game/Paint", { r: Field.f32, g: Field.f32, b: Field.f32 })` and `color: Paint` spawns `Color.Srgb.of({ r, g, b })` and writes `color: Color.Srgb`.
- `colorSpace` is removed. A game that wrote `colorSpace: "srgb-linear"` gives its entities `Color.Linear` and writes `color: Color.Linear`.
- A colour in bytes, fields of `Field.u8`, is no longer read. A game that held `{ r: 0xff, g: 0x61, b: 0x88 }` writes `Color.Srgb.of({ r: 0xff / 255, g: 0x61 / 255, b: 0x88 / 255 })`.
- `Three.ColorComponent` is removed.
- The two refusals when the system was made, of a component that is no colour and of one whose fields are of mixed kinds, are gone, since neither can be written. A number below 0 or over 1 in a `Color.Srgb` still fails the frame, naming the entity.

Nothing breaks in `arcadekit`: `Color` is new.
