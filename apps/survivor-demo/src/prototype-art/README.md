# PROTOTYPE: survivors art direction (#24)

Throwaway code. It answers one question: **what should survivors look like?** It is not production code: no tests, minimal error handling. Once a style is picked, the winner is rewritten properly into `@gamekit/render-three` and `@gamekit/survivors/browser`, and this folder leaves main.

Run it:

```bash
pnpm prototype:art
```

Then open the printed URL. A bar at the bottom switches styles. `[` and `]` also switch (the arrow keys move the hero):

- `?art=a`: today's coloured primitives (baseline).
- `?art=b`: low-poly 3D.
- `?art=c`: pixel-art sprites.
- `?art=d`: smooth cartoon sprites.

Add `&showcase` to skip the menus and watch a crowded fight: the harness fast-forwards a run with the real demo content, keeps the hero alive, and lets it wander. Without it, the demo runs as usual with the chosen style.

All art is made in code (geometry, or sprites painted on a canvas), because asset sites are blocked from the agent's network. The question is the direction, not the final assets.
