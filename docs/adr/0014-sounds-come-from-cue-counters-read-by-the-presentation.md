---
status: accepted
---

# Sounds come from cue counters that the presentation reads

#24 adds sound to the kit. The first question was what triggers a sound. Survivors' sound-worthy moments (shots, hits, kills, gem pickups) can happen hundreds of times a second at about 750 enemies, so they can't be events ([ADR-0008](0008-events-are-rare-facts.md)). Sound must also never influence the simulation, and the recorded replay hashes must not move.

## Decision

**Cue counters.** A genre keeps **cue counters** in its state: running totals of the moments that make a sound, such as `hits`, `kills`, `pickups`, or `pushes` and `undos`. The step bumps them as it goes. They only ever go up during a run, and the step never reads them, so they can't change what a run does. Updating them is a number increment, so the step still doesn't allocate. Every sound comes from a counter, including the rare moments that are also events (a level-up, the end of a run, a solved level), so all of a game's sound comes from one place.

Undo is its own counter. Push-puzzle's undo reverses a turn in place but leaves the counters alone, so nothing counts down.

**The presentation reads them.** A genre's **sound view** is a second `GameView`, next to the view that draws. Each browser frame it compares each counter with the value it saw on its last frame, and plays a sound for each one that went up. It reads the state and never changes it, like any view. A new run is a new state object ([`CONTEXT.md`](../../CONTEXT.md), Run), so the sound view resets what it remembers when the object changes. `combineViews` in `@gamekit/runtime/browser` puts the two views behind one `createView`. So `GamePresentation` doesn't change, and the co-op client, which makes its views itself, makes both.

A frame that ran several steps, or a co-op tab coming back to the foreground after stepping hidden, shows up as a bigger jump in a counter, never as one sound per step. `@gamekit/audio`'s voice limits (a per-sound cap and a minimum gap between starts) keep a jump from playing as a burst.

**State that is already there needs no counter.** A loop that plays while something is true, such as survivors' aura hum while a hero has the aura, is read from the state directly.

**The counters are not hashed.** A genre's state hash (survivors' `hashWorld`) leaves the cue counters out. They follow from the hashed state anyway, and leaving them out keeps every recorded replay and long-run hash as it was.

**Assets stay in the app.** A genre names its counters and plays them through a table of cue to sound that the app passes in, with the app's audio system. The genre ships no audio files. A survivors weapon may name its shot sound in content (`weapons.json` `sound`); a shot without one plays the table's default.

## Considered options

- **An event per sound.** This is simple for push-puzzle, whose sounds are turns. For survivors it breaks ADR-0008: either events become per-entity, or each step gathers per-step cue events, which allocates in the step loop.
- **The sound view compares state.** It could scan survivors' 750 enemy hit-flash timers, or diff push-puzzle's board, each frame. This needs no change to the state. But each genre would write its own comparison code, a frame of several steps would lose moments, and some moments (a kill) leave nothing behind to compare.
- **Counters that the sound view reads and clears.** Clearing means the view writes the state, which breaks the rule that views only read it. Totals that only go up give the same information without the write.
- **A `createAudio` hook on `GamePresentation`.** This changes the runtime contract for something a second view already does.

## Consequences

- `@gamekit/audio` is a browser-only kit package. It has a plain-TypeScript core (unlocking on the first gesture, one-shot sounds with pitch and volume jitter, voice limits, music loops with crossfades, master, sfx and music buses, and mute) and an Effect service and Layer over it, so an app puts it in its resources. Loading a sound list is an Effect with a typed error. Playing a sound is a plain call, so a view can play during `render`.
- A hidden tab is silent. Pausing keeps the music playing but quieter. In co-op a hidden tab keeps stepping but draws nothing, so its sound view plays nothing either.
- In co-op each peer hears the whole shared fight. Hurt and downed sounds are louder for the local hero than for a teammate's.
- Volume and mute are app settings, saved under their own key, where the last write wins ([ADR-0009](0009-a-save-package-is-earned.md)).
- A genre's game definition and engine layer now take the app's audio and cue table, so they are made by functions: `survivorsGame` and `SurvivorsEngineLayer` became `makeSurvivorsGame(sound)` and `makeSurvivorsEngineLayer(sounds)`, and push-puzzle's became `makePushPuzzleGame` and `makePushPuzzleEngineLayer`. This replaces the names [ADR-0010](0010-a-game-is-a-simulation-and-a-presentation.md) kept. (Since [ADR-0015](0015-pixel-art-sprites-loaded-by-the-app.md) they also take the app's sprite sheet: `makeSurvivorsGame({ art, sound })`, `makePushPuzzleGame({ audio, sounds, sheet })`.)
- A third genre adds sound the same way: counters in its state, left out of its hash, and a sound view.
