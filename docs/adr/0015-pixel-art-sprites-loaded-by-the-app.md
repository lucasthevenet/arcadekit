---
status: accepted
---

# Pixel-art sprites from sheets the app loads

#24 asked what the demos should look like, and how loaded art fits a view that is created synchronously. An art prototype put four styles side by side in the survivors demo at full crowd: today's coloured primitives, low-poly 3D, pixel-art sprites, and smooth cartoon sprites. The prototype is kept on branch `prototype/24-art`. The pick is **pixel-art sprites**. They are crisp, cheap (4 draw calls at full crowd, the fastest of the four) and easy to source art for.

## Decision

**The look.**
- The camera looks straight down through an orthographic projection.
- Every sprite pixel covers a whole number of screen pixels, so the art never shimmers.
- Sprites are camera-facing quads. Those lower on screen draw in front.
- In survivors:
  - The hero is 24 px, with an outline and a solid ground marker in its player slot's colour. That keeps it easy to find in a crowd, and tells co-op players apart even when two pick the same hero.
  - Enemies are 16 px.
  - The ground stays calm so the characters stand out.
- The 3D look leaves the demos. Push-puzzle moves to pixel tiles and sprites too, so the kit's sprite code serves two genres ([ADR-0001](0001-kit-changes-need-two-genres.md)).

**The kit.** `@gamekit/render-three` gains:
- **Instanced sprites:** many sprites from one sheet in one draw call, each with its own position, frame, flip, tint and flash.
- **A sprite sheet loader:** the image and its frames, loaded as an Effect with a typed error.
- **A pixel camera:** an orthographic camera that snaps so sprite pixels stay whole.

**Sheets are Aseprite JSON.** A sheet is a PNG plus the JSON that Aseprite, LibreSprite and TexturePacker export. The loader reads the frames, their sizes and the frame tags. Tags name animations (`slime/move`), so art made in those tools drops in without conversion. The demos' first sheets come from the prototype's art, which was painted in code. A script exports it to PNG and JSON, like the generated placeholder sounds. A CC0 pack or new art can replace those files.

**The app loads the sheets and owns them.** `createView` stays synchronous, and `GamePresentation` doesn't change. The app loads its sheets at startup and passes them into the genre's game (`makeSurvivorsGame`), the same way the audio system is passed in ([ADR-0014](0014-sounds-come-from-cue-counters-read-by-the-presentation.md)). The sheets live as long as the app, so a view's `dispose` frees only what the view made, never a sheet. That removes the shared-asset disposal problem #24 raised.

**Content names the art.** Enemies, heroes and weapons gain an optional `sprite` field: a tag in the sheet. Without it, a generic sprite is drawn in the content's existing `color`.

## Considered options

- **Low-poly 3D.** The most premium look. But the horde hid the hero, a dense bat swarm read as texture, and its frame was the slowest of the four.
- **Smooth cartoon sprites.** The most readable at full crowd. But large blended sprites cost a lot of fill, and free CC0 art in that style is scarce.
- **An async `createView`.** This would let a view load its own assets, but it changes the runtime contract and makes every attach wait. Loading once in the app is simpler and loads each asset once.
- **Our own sheet format.** Simpler to parse, but it would force a conversion step on art from the usual tools.

## Consequences

- Replay and determinism hashes don't change: only drawing changes.
- Today's `SurvivorsView` and `PushPuzzleView` are replaced by sprite views. `Stage`, `MeshInstances` and the 3D camera helpers stay in the kit for other games.
- A failed sheet load is shown as an error on the app's loading screen, like a failed content load. A game can't be drawn without its sheet.
- A new enemy or hero gets art by adding frames to the sheet and naming the tag in content, with no code change.
