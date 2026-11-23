---
title: "Drawing performance"
description: "What @arcadekit/three costs a frame, as measured by its benchmark: instances and objects, flat and smooth drawing, colours, and looks built from assets."
---

This guide lists what [`@arcadekit/three`](drawing-with-three.md) costs a frame, as measured by its benchmark, and how to run the benchmark yourself. [Performance](performance.md) lists what the rest of arcadekit costs.

## Instances and objects

The work `@arcadekit/three` does before Three.js takes over: 10,000 entities, one frame, with a renderer that draws nothing. These are medians after warm-up, on the kind of machine [reading the numbers](performance.md#reading-the-numbers) describes.

| Variant | ns/entity | Bytes allocated per frame |
| --- | --- | --- |
| `Three.instances`: a position | 9.8 | 6,700 |
| `Three.instances`: a position and a scale | 11.2 | 7,400 |
| `Three.instances`: a position and a rotation | 15.0 | 7,400 |
| `Three.instances`: all three | 18.2 | 7,100 |
| `Three.instances`, flat: a position | 8.0 | 7,300 |
| `Three.instances`, flat: a position and a scale | 8.3 | 7,100 |
| `Three.instances`, flat: a position and a rotation | 35.7 | 7,200 |
| `Three.instances`, flat: all three | 35.9 | 7,200 |
| `Three.instances`, smooth: a position | 26.9 | 7,300 |
| `Three.instances`, smooth: all three | 71.8 | 7,300 |
| `Three.instances`, smooth, flat: a position | 23.1 | 7,300 |
| `Three.instances`, smooth, flat: all three | 82.5 | 7,300 |
| `Three.instances`, a colour each: a position | 14.7 | 7,400 |
| `Three.instances`, a colour each, as the renderer has it: a position | 10.9 | 7,400 |
| `Three.instances`, a colour each, smooth: a position | 44.7 | 7,800 |
| `Three.instances`, a look made of assets: a position | 8.7 | 8,000 |
| `Three.objects`: an Object3D each, all three copied | 163.0 | 5,700 |
| `Three.objects`, flat: an Object3D each, all three copied | 167.8 | 5,700 |
| By hand: `world.get` and `setMatrixAt`, per entity | 361.6 | 2,480,000 |

- Ten thousand moving objects, drawn where the last tick left them, cost 0.08 to 0.36 ms of a frame. The seven kilobytes are per-frame overhead, the same for one entity as for ten thousand. A test holds the system to under 4 bytes per object per tick and frame, where allocating one number per object would take 12.
- An object per entity costs ten to twenty times as much as an instance, mostly Three.js keeping each object's Euler angles in sync with its quaternion. That's why crowds use instances.
- An unrotated flat entity costs slightly less than a 3D one. A rotated one costs twice as much, 36 ns: a sine and a cosine each, where a quaternion takes a few multiplications.
- With `smooth` interpolation, an entity costs about three times as much for a position, 27 ns, and four times for all three, 72 ns: each value is read, stored, and blended with the previous one. Ten thousand cost 0.27 to 0.83 ms of a frame, still with no per-entity allocation.
- A per-instance colour costs about 6 ns more per entity, mostly the colour conversion. In the renderer's space, a `Color.Linear`, it costs 2 ns. Interpolated, it costs 22 ns more, the same as interpolating the position.
- A look built from assets adds no per-entity cost: the loops are the same. Checking that the assets are still loaded happens twice per frame, allocates under a kilobyte, and takes too little time to measure.
- In headless Chromium, the example page with 10,000 lit cubes grew its heap by 7 to 58 KB per frame, including the renderer's own allocations, and by 17 KB with a hundred cubes: per-frame allocation doesn't grow with what is drawn. Headless Chromium renders in software, so this says nothing about GPU rendering speed.

## Running the benchmark

The benchmark lives in the repository, not in the published package. From a checkout:

```sh
pnpm --filter @arcadekit/three bench
```

It is in [`packages/three/bench`](../../../../../packages/three/bench).

## Read more

- [Instances and objects](instances-and-objects.md), for when to use each, and [interpolation](between-two-ticks.md), for `smooth`.
