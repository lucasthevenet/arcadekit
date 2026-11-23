---
"arcadekit": patch
---

A frame that fails plays nothing it asked `Sound.Player` for, and holds nothing against the next frame. Before, what it said of a channel stood until a frame ended well, so a system that set another track on that channel in the next frame was refused as if two systems had spoken in one frame, and the cues it asked for played a frame late. `Sound.plugin` now adds `arcadekit/Sound.Begin` in `"preFrame"`, which starts each frame with nothing requested.

Nothing a game writes changes. `app.frameOrder` lists `arcadekit/Sound.Begin` before the frame's other systems.
