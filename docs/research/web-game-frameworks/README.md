# Web game frameworks beside arcadekit

Research for [the roadmap of the kit's complete API](https://github.com/lucasthevenet/arcadekit/issues/79). Read on 2026-11-12, against arcadekit 0.6.0.

## Question

What do the most used web game frameworks offer a game, in what shape, and what did they later have to undo? Which of it should arcadekit have, and which should it refuse?

## What was read

| Framework | Version | Read from |
| --- | --- | --- |
| Phaser | 4.2.1 | the npm package `phaser`: `types/phaser.d.ts`, the `skills/` and `docs/` it ships, its changelogs |
| KAPLAY | 3001.0.19 | the npm package `kaplay`: `dist/doc.d.ts`; the guides on kaplayjs.com; its changelog |
| PixiJS | 8.23.0 | the npm package `pixi.js`: the type definitions under `lib/`, the `skills/` it ships; pixijs.com guides |
| melonJS | 18.2.2 | the npm package `melonjs`: the type definitions and the bundle under `build/`; its wiki and changelog |

A citation such as `types/phaser.d.ts:93629` is a path from the package's root and a line. Each file's first paragraph says what else it cites.

## Files

- [`phaser-world.md`](phaser-world.md) and [`phaser-systems.md`](phaser-systems.md): Phaser, in two halves (scenes, objects, drawing, cameras and animation; then the loop, physics, input, audio, loading, data, math and scale).
- [`kaplay.md`](kaplay.md), [`pixijs.md`](pixijs.md), [`melonjs.md`](melonjs.md).
- [`evidence-kit-games.md`](evidence-kit-games.md): what survivors and push-puzzle write for themselves on arcadekit 0.6.0, need by need, with the files and their sizes. The same count for grimbonk, a game outside this repository, is kept in its own repository. The roadmap's tiers count the three.

Every framework file has the same four parts: **Shape** (how a game is put together, with the smallest complete game its docs show), **Features** in seventeen areas (loop, scenes, entities, render, camera, animation, physics, input, audio, assets, data, math, ui, display, debug, platform, net), each marked core, common or niche with its source, **Ideas worth taking**, and **Traps**: what the framework shipped and later removed, replaced or warned its own users against.

## Answer in short

- **The four share one shape, and it is not the kit's.** A game is a tree of mutable objects in a scene, changed by callbacks on a variable-delta loop. None has a deterministic step, a replay, a declared command or a network layer. The kit keeps its rules as data in pools, stepped at a fixed rate, with views that only read and an app written in Foldkit. So scenes, game objects, tween managers, physics bodies, canvas UI, global emitters and plugins stay out, and most of the traps the four record are things that shape forced on them.
- **What they offer that the kit's games already write by hand is small tools.** Timers as numbers, easing, picks from a seeded generator, nearest and within queries, a tile map, sprite batches that grow, walk or idle, loading several assets as one, what a view is told about a frame, one pause, labels for bindings, and the app's load, retry and audio glue. Two or three of the three games write each of these today: that is the roadmap's first tier.
- **What one game has shown waits for a second** (ADR-0001): the mouse and a pointer lock, on-screen buttons, particles, camera shake, a sound placed in the world, the fraction between two steps.
- **What only a newcomer would look for waits for a game**: paths over a tile map, Tiled maps, rebinding, a camera's bounds, a save's version.

The roadmap has the item-by-item table, the tiers and the issues.
