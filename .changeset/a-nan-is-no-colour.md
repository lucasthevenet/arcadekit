---
"@arcadekit/three": minor
---

`Three.instances` with `color: Color.Srgb` fails the frame for a channel that is NaN, as it does for one below 0 or over 1. NaN, an infinity, and a number so large it wrapped past 32 bits used to be drawn as some other colour, NaN as black, with no error.

**Breaking**

- A game whose `Color.Srgb` holds NaN or an infinity, such as a division by zero leaves, now fails the frame with an error that names the entity, where it drew black. Give it a number from 0 to 1.
