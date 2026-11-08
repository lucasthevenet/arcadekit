---
"@arcadekit/render-three": patch
---

`Stage.dispose()` releases its WebGL context (`forceContextLoss`). It used to leave the context alive until the canvas was collected, so a game that makes stages one after another (a view per attach) piled them up. Chrome keeps 16 a page and then kills the oldest, which can be a live stage's, and a page that keeps losing them can be refused new ones ("Error creating WebGL context").
