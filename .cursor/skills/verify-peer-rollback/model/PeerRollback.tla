----------------------------- MODULE PeerRollback -----------------------------
(***************************************************************************
 * Model of one arcadekit peer's rollback receive / tick path.
 *
 * Mirrors packages/arcadekit/src/net/Peer.ts:
 *   - receive: stores remote actions, advances `have`, sets `wrong` only when
 *     a late message has actions.length > 0
 *   - tickExit: if wrong is set, rewinds to that tick and resimulates, then
 *     may run one more predicted tick
 *   - confirmed: min(known, tick) unless wrong is set, then min(known, wrong)
 *   - moments / kept: a snapshot for each predicted tick; never more than Ahead
 *
 * The local peer is ada. One remote peer grace sends, for each tick, either an
 * empty action list or a single Drop. Ada's own messages are always present
 * (delay 0). Simulation is abstracted as recording which remote actions were
 * applied on each tick.
 *
 * Left out: multi-remote peers, delay > 0, duplicates already delivered,
 * resend / unheard, Drift checkpoints, transport reconnect, frame stages.
 ***************************************************************************)
EXTENDS Integers, FiniteSets, Sequences, TLC

CONSTANTS MaxTick, Ahead

ASSUME MaxTick \in Nat /\ MaxTick >= 1
ASSUME Ahead \in Nat /\ Ahead >= 1

Ticks == 0 .. MaxTick
Empty == "empty"
Drop == "drop"
Action == {Empty, Drop}

VARIABLES
  tick,
  haveGrace,
  heldGrace,
  gracePlan,
  delivered,
  wrong,
  moments,
  applied,
  rewinds,
  pending

vars == <<tick, haveGrace, heldGrace, gracePlan, delivered, wrong, moments,
          applied, rewinds, pending>>

-----------------------------------------------------------------------------

Min(a, b) == IF a < b THEN a ELSE b

Known == Min(haveGrace, tick)

Confirmed ==
  IF wrong = -1 THEN Known ELSE Min(Known, wrong)

CanPredict ==
  (tick - Known < Ahead) /\ (tick <= MaxTick)

Put(f, k, v) ==
  [x \in (DOMAIN f \cup {k}) |-> IF x = k THEN v ELSE f[x]]

ApplyAt(n, held) ==
  IF n \in DOMAIN held THEN held[n] ELSE Empty

\* First tick >= start that is not yet in held (Peer have-advance loop).
AdvanceHave(start, held) ==
  CHOOSE h \in start .. (MaxTick + 2) :
    /\ \A i \in start .. (h - 1) : i \in DOMAIN held
    /\ (h > MaxTick \/ h \notin DOMAIN held)

MomentsAfterRun(n, have, prev) ==
  IF have > n THEN prev \ {n} ELSE prev \cup {n}

PruneMoments(ms, have, now) ==
  LET final == Min(have, now)
  IN {m \in ms : m >= final}

\* Re-apply grace actions for ticks from .. upto-1 after a rewind.
ResimFrom(from, upto, held, prevApplied) ==
  [t \in (DOMAIN prevApplied \cup (from .. (upto - 1))) |->
     IF t >= from /\ t < upto THEN ApplyAt(t, held) ELSE prevApplied[t]]

\* Moments after resimulating from..tick-1 then pruning is approximated by
\* rebuilding prediction marks for ticks still not final.
MomentsAfterResim(from, upto, have, prev) ==
  LET stepped ==
        UNION {
          IF n \in from .. (upto - 1)
          THEN MomentsAfterRun(n, have, {})
          ELSE {}
          : n \in Ticks
        }
      keptOlder == {m \in prev : m < from}
  IN PruneMoments(keptOlder \cup stepped \cup
       (IF upto <= MaxTick /\ have <= upto THEN {upto} ELSE {}),
       have, upto)

TypeOK ==
  /\ tick \in 0 .. (MaxTick + 1)
  /\ haveGrace \in 0 .. (MaxTick + 2)
  /\ wrong \in (-1 .. MaxTick)
  /\ moments \subseteq Ticks
  /\ delivered \subseteq Ticks
  /\ pending \subseteq Ticks
  /\ rewinds \in Nat
  /\ \A t \in Ticks : gracePlan[t] \in Action
  /\ \A t \in DOMAIN heldGrace : t \in Ticks /\ heldGrace[t] \in Action
  /\ \A t \in DOMAIN applied : t \in Ticks /\ applied[t] \in Action

-----------------------------------------------------------------------------

Init ==
  /\ tick = 0
  /\ haveGrace = 0
  /\ heldGrace = [t \in {} |-> Empty]
  /\ gracePlan \in [Ticks -> Action]
  /\ delivered = {}
  /\ wrong = -1
  /\ moments = {}
  /\ applied = [t \in {} |-> Empty]
  /\ rewinds = 0
  /\ pending = Ticks

-----------------------------------------------------------------------------

Receive(t) ==
  /\ t \in pending
  /\ t >= haveGrace
  /\ t \notin delivered
  /\ LET acts == gracePlan[t]
         lateNonEmpty == (t < tick) /\ (acts = Drop)
         held1 == Put(heldGrace, t, acts)
     IN
       /\ heldGrace' = held1
       /\ delivered' = delivered \cup {t}
       /\ pending' = pending \ {t}
       /\ haveGrace' = AdvanceHave(haveGrace, held1)
       /\ wrong' =
            IF lateNonEmpty
            THEN IF wrong = -1 THEN t ELSE Min(wrong, t)
            ELSE wrong
       /\ UNCHANGED <<tick, gracePlan, moments, applied, rewinds>>

Tick ==
  /\ CanPredict
  /\ LET
       doRewind == wrong # -1
       from == IF doRewind THEN wrong ELSE 0
       applied1 ==
         IF doRewind THEN ResimFrom(from, tick, heldGrace, applied) ELSE applied
       rewinds1 == IF doRewind THEN rewinds + 1 ELSE rewinds
       baseMoments ==
         IF doRewind
         THEN
           LET rebuilt ==
                 {n \in from .. (tick - 1) : haveGrace <= n}
           IN PruneMoments(rebuilt, haveGrace, tick)
         ELSE moments
       applied2 == Put(applied1, tick, ApplyAt(tick, heldGrace))
       moments2 == MomentsAfterRun(tick, haveGrace, baseMoments)
       moments3 == PruneMoments(moments2, haveGrace, tick + 1)
     IN
       /\ tick' = tick + 1
       /\ applied' = applied2
       /\ moments' = moments3
       /\ wrong' = -1
       /\ rewinds' = rewinds1
       /\ UNCHANGED <<haveGrace, heldGrace, gracePlan, delivered, pending>>

Done ==
  /\ pending = {}
  /\ ~CanPredict
  /\ UNCHANGED vars

Next ==
  \/ \E t \in pending : Receive(t)
  \/ Tick
  \/ Done

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------

EmptyLateNeverSetsWrong ==
  \A t \in delivered :
    (gracePlan[t] = Empty) => ~((wrong = t) /\ (t < tick))

WrongOnlyFromLateDrop ==
  \/ wrong = -1
  \/ /\ wrong \in delivered
     /\ gracePlan[wrong] = Drop
     /\ wrong < tick

ConfirmedPrefixMatchesPlan ==
  \A t \in Ticks :
    (t < Confirmed) => (t \in DOMAIN applied /\ applied[t] = gracePlan[t])

KeptWithinAhead ==
  Cardinality(moments) <= Ahead

ConfirmedRespectsWrong ==
  (wrong = -1) \/ (Confirmed <= wrong)

=============================================================================
