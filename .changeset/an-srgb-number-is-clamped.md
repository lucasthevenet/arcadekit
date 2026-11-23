---
"@arcadekit/three": minor
---

`Three.instances` with `color: Color.Rgb` draws a channel in `Color.Srgb` below 0 as 0 and one over 1 as 1, as CSS clamps an sRGB colour, where it failed the frame. NaN and an infinity still fail the frame with an error that names the entity. A channel from 0 to 1, and any colour in `Color.Linear`, is drawn as before. Nothing breaks: a game that drew before draws the same.
