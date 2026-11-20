---
"@arcadekit/three": minor
---

`Three.instances` with a `color` draws an entity of its kind that has no colour in the material's own colour, as if its colour were white. It used to leave that entity out with no error, so giving some entities a colour hid the others.

**Breaking**

- An entity without the colour component is now drawn. A game that left the colour off to hide an entity puts it in `without` instead.
