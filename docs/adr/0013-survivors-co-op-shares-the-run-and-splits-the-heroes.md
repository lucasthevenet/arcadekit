---
status: accepted
---

# Survivors co-op shares the run and gives each player a hero

> Since [ADR-0019](0019-the-kit-owns-co-op-and-the-app-keeps-the-screens.md): `SurvivorsInput` is the kit's `PlayerInputs<HeroInput>`, so `heroes` reads `players` there. `combineHeroInputs` is `combinePlayerInputs` (`arcadekit/net`) and survivors' `soloInput` is `arcadekit/runtime`'s. The demo's co-op lobby and client are the kit's Co-op client, which runs `survivorsCoopRules`; the views read `localHero` as a function, on every frame.
>
> Since [ADR-0020](0020-a-game-is-declared.md): a single-player pick is the command `ChooseUpgrade`, sent with `engine.send` and applied at the start of the next step. `chooseUpgrade` and the engine's `modify` are gone from survivors; a lockstep run's pick still rides the input until co-op moves. `SurvivorsInput` is declared with `Game.PlayerInputs(HeroInput)` and `soloInput` is `arcadekit/game`'s. A lockstep run steps the declared `Survivors`, and takes the one-player Schema and the combining from that input: no game passes `schemaCodec(HeroInput)` or `combinePlayerInputs` any more.

[ADR-0012](0012-delay-based-lockstep-over-a-host-star.md) left survivors' co-op rules to the genre. #25's grilling settled them: one shared team XP pool fed by any gem, a level-up that pauses everyone while each player picks their own upgrade, enemies that chase the nearest player, 2 to 4 players, and a removed player's hero leaving the run. This records how `@gamekit/survivors` implements them, and the rules the issue didn't settle.

**One hero per player; everything else is shared.** `World.heroes` holds one `Hero` per player, by **slot**: the player's place in player order, host first in lockstep (`SurvivorsConfig.heroIds`). A hero (`hero.ts`) owns its body, stats, weapons, passives, upgrade offer and pause flag. The run (`world.ts`) owns the clock, kills, the team's level and XP, the horde, projectiles, gems and the one `Rng`. Heroes are never removed from the array, so slots stay stable; a hero whose player leaves is marked `left`.

**Every rule visits heroes in slot order.** Movement, contact damage, weapons, regen and offers loop over the heroes in slot order, and every random draw comes from the shared `Rng` in that order, so every peer computes the same step.

- **Nearest hero.** An enemy chases, and a gem flies to, the playing hero nearest it by squared distance, with exact arithmetic ([ADR-0011](0011-a-step-uses-only-exact-math.md)). The lowest slot wins a tie.
- **Spawns.** Each new enemy spawns on the ring around the next playing hero in turn (`World.spawnCursor`), with no extra draw from the `Rng`.
- **Projectiles** stay in one shared pool with their damage baked in. Their `weapon` field is `slot * MAX_WEAPONS + index`, for the view's colors.

**A level-up freezes the run until every playing hero has picked.** Any gem feeds the team's XP. A level-up opens a new offer (`World.offerSeq` numbers them): each playing hero, in slot order, gets its own choices and a `levelUp` event. The run doesn't advance while any hero has an offer open. It resumes in the step that closes the last one, by a pick or by its player leaving.

**Picks, pause and leaving are step input.** A step's `SurvivorsInput` is each hero's `HeroInput`, by slot, plus the slots leaving at that step. A `HeroInput` can carry `pick: { offer, index }`, applied only while that hero has offer `offer` open: lockstep schedules input `inputDelay` steps ahead, so a pick repeated or arriving after its offer closed does nothing. `paused: true` holds a co-op run paused while that player's hero is playing. `combineHeroInputs` turns `@gamekit/net`'s confirmed steps into this input, and `soloInput` wraps one player's source for single-player. A step applies leaving first, then picks, then the freeze and pause checks.

**Single-player keeps `modify` and `setPaused`.** `chooseUpgrade(world, slot, index)` is the same pick, applied at once; the demo calls it through `engine.modify` and pauses with `setPaused`, as ADR-0012 allows. With one hero, a pick through `modify` before a step and the same pick as that step's input give the same run (tested).

**A hero at 0 HP is down, with no revive.** A downed hero stays where it fell: it doesn't move, fight, regenerate, collect gems or get offers, and nothing chases it. The run is lost once no hero is playing. With one hero, down is dead in the same step, as before.

**A one-hero run is the single-player game, bit for bit.** Every rule above reduces, for one hero, to the expressions and `Rng` draws the single-player step always made, in the same order. The state hash (`visitWorld`) visits the first hero with the team's level and XP in the old player record's order, and adds the offer state, spawn cursor and other heroes only when there is more than one hero. So survivors' pinned replay and determinism hashes didn't move.

## Considered Options

- **Per-player XP.** Each hero levels on its own gems. Rejected in #25's grilling: co-op should share progress, and a team level keeps the freeze to one level-up at a time.
- **Pick while the run continues.** No freeze; a hero's offer waits in the HUD. Rejected in the grilling: it lets one player fall behind with an unspent upgrade, and the single-player game freezes.
- **Revive a downed hero** (stand near it for a few seconds). Left out of the first version: it needs a rule, a timer and UI the issue didn't settle. A downed hero's player watches until the run ends.
- **Keep a `world.player` and single-input API beside the N-player one,** so the replay and determinism test files stay byte-identical. Rejected: two APIs for one rule set. The tests follow the new API mechanically and their pinned hashes are unchanged.
- **Spawn around a random hero.** One more `Rng` draw per spawn would move every single-player hash. Taking turns costs no draw.

## Consequences

- A lockstep run passes `combineHeroInputs(session players)` as `combine`, `schemaCodec(HeroInput)` as the codec and `heroIds` in player order as the config, and needs no `modify` (tested over the in-memory network in `packages/survivors/src/lockstep.test.ts`).
- `HudSample` carries the team's numbers plus one `HeroHud` per slot, and `runEnded` carries one `RunSummary` per hero. A single-player app reads slot 0.
- Events are plain data: a `levelUp`'s choices are copies, not the state's offer.
- The view draws every hero and follows `localHero` (default 0). It greys and lays down a downed hero only in co-op, so a lone hero's death frame looks as it always has. The survivors demo's co-op lobby picks heroes, and its run follows the local player's hero and shows "waiting for X".
