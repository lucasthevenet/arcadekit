---
"arcadekit": patch
---

`System.Misordered`, `System.Listing`, `System.Duplicated` and `System.Ordered` are declared in `System` itself, so the reference links each to `src/System.ts`. The built package no longer has `dist/system/order.js` and `dist/system/order.d.ts`, which no entry exported. Nothing breaks.
