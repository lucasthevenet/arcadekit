---
layout: home
title: arcadekit
titleTemplate: Primitives for browser games

hero:
  name: arcadekit
  text: Primitives for browser games
  tagline: A deterministic simulation, a game loop, input, saves, audio, pixel art and lockstep co-op. One package, on Effect, Foldkit and Three.js.
  image:
    src: /favicon.svg
    alt: ""
  actions:
    - theme: brand
      text: Get started
      link: "#install"
    - theme: alt
      text: Play GRIMBONK
      link: https://grimbonk.arcadekit.dev
    - theme: alt
      text: GitHub
      link: https://github.com/lucasthevenet/arcadekit

features:
  - title: The same run on every peer
    details: A fixed-step clock, a seeded random generator and pools that allocate nothing per step. The same seed and inputs give the same run.
    link: /core
    linkText: arcadekit/core
  - title: A game is two halves
    details: A simulation with no DOM, and the input and view that present it. The loop steps the first anywhere, and the engine draws it in a browser.
    link: /runtime
    linkText: arcadekit/runtime
  - title: Co-op in lockstep
    details: Two to four players run one simulation over WebRTC, joined by a code. The signalling worker for Cloudflare is an entry too.
    link: /net
    linkText: arcadekit/net
  - title: Effect at the edges
    details: Loading, engines, saves and connections are Effect. The step, the views and input are plain code.
    link: /adr/0017-effect-at-the-edges-plain-code-inside
    linkText: ADR-0017
---

arcadekit is one package of primitives for browser games made with [Effect](https://effect.website) 4, [Foldkit](https://foldkit.dev) and [Three.js](https://threejs.org). Each of its entries has a page here.

<!-- The package's README, after its title and first paragraph (.vitepress/pages.ts checks the range). -->
<!--@include: ../../packages/arcadekit/README.md{5,}-->

## Games built on it

- [GRIMBONK](https://grimbonk.arcadekit.dev) is a grimdark third-person survivors-like, built on the published package. Play it in the browser.
- [The survivors demo](https://github.com/lucasthevenet/arcadekit/tree/main/apps/survivor-demo) is a survivors-like with co-op for two to four players. Its genre package is [`packages/survivors`](https://github.com/lucasthevenet/arcadekit/tree/main/packages/survivors).
- [The push-puzzle demo](https://github.com/lucasthevenet/arcadekit/tree/main/apps/push-puzzle-demo) is a Sokoban-like with undo. Its genre package is [`packages/push-puzzle`](https://github.com/lucasthevenet/arcadekit/tree/main/packages/push-puzzle).

The demos don't publish: copy from them. [The repository's README](https://github.com/lucasthevenet/arcadekit#making-a-new-game) says how to make a new game, in an existing genre or a new one.
