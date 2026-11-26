---
"arcadekit": minor
---

A lobby's player says what it began with as it begins, and again whenever a peer speaks in the lobby or joins the room, for as long as its connection is open. A peer that lost the first saying, because a socket dropped, begins with the same names, seed and settings once the two hear each other again, where it waited in the lobby, or failed with `Lobby.Full` though it was a player. A peer that hears a player's session before what the player began with asks for it, and fails with `Lobby.Full` only when the player began without it. Nothing breaks.
