---
"arcadekit": minor
---

Each script reads events and changes from a place of its own, for as long as it runs, as a system does. `(yield* Ping).read()` in a script returned nothing, since each `yield*` gave a new handle that started from then, and two scripts that read the same change query took its changes from each other.

**Breaking**

- In a script, `yield*` of an event gives the same handle every time, which starts from the oldest event still kept, and a change query or `Query.removed` visits only what that script hasn't. A script that kept one handle, or that counted on sharing a change query with another script, now sees what it had missed.
- A save no longer holds the place of a plugin's script in a change query: the script starts again after a load and visits everything on its first visit.
