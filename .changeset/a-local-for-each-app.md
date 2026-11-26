---
"arcadekit": minor
---

What a frame or an input system keeps from one frame to the next, such as a camera's angle or when a HUD was last shown, has a home: `const Orbit = System.local(() => ({ angle: 0 }))`, and `(yield* Orbit).angle += delta` in the system. Each app has its own value, made the first time one of its systems yields the local and passed to `System.local(make, release)`'s `release` when the app closes, so two apps of one game share nothing, as two apps sharing a variable of a module did. Every system that yields one local shares its value, so an input system can set what a frame system, or the condition of `Assets.during`, reads. The value is outside the world: a save, the hash and a rewind leave it as it is. A system of the tick, a hook, a handler or a plugin's setup that yields a local doesn't compile, since what the tick keeps belongs in the world.

Nothing breaks. `Services.BuiltIn` includes `System.Locals`, the service the app provides to its frame and input stages. The Three.js example page keeps its camera, its HUD and whether its deck is out in locals, and reads the C key in the input stage where it listened to the page.
