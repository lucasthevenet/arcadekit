---
"@arcadekit/three": patch
---

A kind drawn with `smooth: true` allocates about 3.5 KB less each frame. It asked the app for all three stores of what was drawn a tick ago, those of `Transform3d.smooth`, `Transform2d.smooth` and `Color.smooth`, together, and now asks for the one of its transform, and for the colour's only when it has a colour. A frame of 10,000 entities drawn smoothly allocates 600 to 800 bytes more than one drawn where the last tick left them, where it allocated about 4 KB more. Nothing breaks.
