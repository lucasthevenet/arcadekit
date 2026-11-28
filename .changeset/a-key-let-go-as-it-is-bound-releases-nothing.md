---
"arcadekit": patch
---

A key that is held when a control is bound to it, and let go before the next sample, releases nothing. Before, an input system read the control as `released` at that sample, though it never read it pressed or held. The control moves from the key's next press, as it does for a key still down at that sample. The tick and the frame read nothing at that sample, as before. Nothing breaks.
