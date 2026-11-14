# Stages and cameras

`Stage.make(container, options)` makes a WebGL renderer whose canvas fills `container`, a scene, and the camera `options.camera` names: `"perspective"` (the default) for a 3D world seen from a point, `"orthographic"` for a flat board, and `"pixel"` for pixel art seen straight down. Its `renderer`, `scene` and `camera` are fields a view uses as Three.js's own: `stage.scene.add(mesh)`, `stage.scene.fog`, a perspective camera's `fov`. `Stage.render(stage)` draws the scene once, at the end of a view's frame.

It resizes with its container. A perspective camera takes the new aspect ratio, an orthographic one keeps its view height and widens or narrows, and a pixel camera picks its pixel scale again. A pixel stage sizes its drawing buffer to the canvas's exact device pixels, where the others cap the pixel ratio at 2.

`Stage.dispose(stage)` frees every geometry, material and texture in its scene, but for the textures `Stage.keepTexture` marked, such as a sprite sheet's, then releases the WebGL context and removes the canvas. A view that takes an object out of the scene frees it with `Stage.disposeObject(object)`, which skips kept textures too.

A view makes its stage when it is made, and disposes it in its own `dispose`: the engine makes the view on each attach and disposes it when the attach ends, so the stage lives as long as the attach.

## Cameras

The 3D cameras are placed by `Camera`: `Camera.follow(camera, target, offset)` keeps a fixed offset from a point on the ground, `Camera.orbit` circles one, and `Camera.fit(camera, bounds, options)` shows a rectangle of ground whole, at the camera's aspect ratio. A pixel camera is placed by its own functions, which keep its pixels whole: `PixelCamera.follow(camera, x, z)` centres it on a point, and `PixelCamera.fit(camera, bounds, margin)` shows an area at the largest whole pixel scale that fits.
