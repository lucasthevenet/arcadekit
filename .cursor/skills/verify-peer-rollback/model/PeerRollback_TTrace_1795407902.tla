---- MODULE PeerRollback_TTrace_1795407902 ----
EXTENDS Sequences, TLCExt, PeerRollback, Toolbox, Naturals, TLC

_expression ==
    LET PeerRollback_TEExpression == INSTANCE PeerRollback_TEExpression
    IN PeerRollback_TEExpression!expression
----

_trace ==
    LET PeerRollback_TETrace == INSTANCE PeerRollback_TETrace
    IN PeerRollback_TETrace!trace
----

_inv ==
    ~(
        TLCGet("level") = Len(_TETrace)
        /\
        gracePlan = ((0 :> "empty" @@ 1 :> "empty" @@ 2 :> "empty" @@ 3 :> "drop"))
        /\
        moments = ({0})
        /\
        heldGrace = ((0 :> "empty"))
        /\
        applied = ((0 :> "empty"))
        /\
        haveGrace = (1)
        /\
        rewinds = (0)
        /\
        pending = ({1, 2, 3})
        /\
        delivered = ({0})
        /\
        tick = (1)
        /\
        wrong = (0)
    )
----

_init ==
    /\ gracePlan = _TETrace[1].gracePlan
    /\ delivered = _TETrace[1].delivered
    /\ heldGrace = _TETrace[1].heldGrace
    /\ applied = _TETrace[1].applied
    /\ moments = _TETrace[1].moments
    /\ pending = _TETrace[1].pending
    /\ wrong = _TETrace[1].wrong
    /\ haveGrace = _TETrace[1].haveGrace
    /\ tick = _TETrace[1].tick
    /\ rewinds = _TETrace[1].rewinds
----

_next ==
    /\ \E i,j \in DOMAIN _TETrace:
        /\ \/ /\ j = i + 1
              /\ i = TLCGet("level")
        /\ gracePlan  = _TETrace[i].gracePlan
        /\ gracePlan' = _TETrace[j].gracePlan
        /\ delivered  = _TETrace[i].delivered
        /\ delivered' = _TETrace[j].delivered
        /\ heldGrace  = _TETrace[i].heldGrace
        /\ heldGrace' = _TETrace[j].heldGrace
        /\ applied  = _TETrace[i].applied
        /\ applied' = _TETrace[j].applied
        /\ moments  = _TETrace[i].moments
        /\ moments' = _TETrace[j].moments
        /\ pending  = _TETrace[i].pending
        /\ pending' = _TETrace[j].pending
        /\ wrong  = _TETrace[i].wrong
        /\ wrong' = _TETrace[j].wrong
        /\ haveGrace  = _TETrace[i].haveGrace
        /\ haveGrace' = _TETrace[j].haveGrace
        /\ tick  = _TETrace[i].tick
        /\ tick' = _TETrace[j].tick
        /\ rewinds  = _TETrace[i].rewinds
        /\ rewinds' = _TETrace[j].rewinds

\* Uncomment the ASSUME below to write the states of the error trace
\* to the given file in Json format. Note that you can pass any tuple
\* to `JsonSerialize`. For example, a sub-sequence of _TETrace.
    \* ASSUME
    \*     LET J == INSTANCE Json
    \*         IN J!JsonSerialize("PeerRollback_TTrace_1795407902.json", _TETrace)

=============================================================================

 Note that you can extract this module `PeerRollback_TEExpression`
  to a dedicated file to reuse `expression` (the module in the 
  dedicated `PeerRollback_TEExpression.tla` file takes precedence 
  over the module `PeerRollback_TEExpression` below).

---- MODULE PeerRollback_TEExpression ----
EXTENDS Sequences, TLCExt, PeerRollback, Toolbox, Naturals, TLC

expression == 
    [
        \* To hide variables of the `PeerRollback` spec from the error trace,
        \* remove the variables below.  The trace will be written in the order
        \* of the fields of this record.
        gracePlan |-> gracePlan
        ,delivered |-> delivered
        ,heldGrace |-> heldGrace
        ,applied |-> applied
        ,moments |-> moments
        ,pending |-> pending
        ,wrong |-> wrong
        ,haveGrace |-> haveGrace
        ,tick |-> tick
        ,rewinds |-> rewinds
        
        \* Put additional constant-, state-, and action-level expressions here:
        \* ,_stateNumber |-> _TEPosition
        \* ,_gracePlanUnchanged |-> gracePlan = gracePlan'
        
        \* Format the `gracePlan` variable as Json value.
        \* ,_gracePlanJson |->
        \*     LET J == INSTANCE Json
        \*     IN J!ToJson(gracePlan)
        
        \* Lastly, you may build expressions over arbitrary sets of states by
        \* leveraging the _TETrace operator.  For example, this is how to
        \* count the number of times a spec variable changed up to the current
        \* state in the trace.
        \* ,_gracePlanModCount |->
        \*     LET F[s \in DOMAIN _TETrace] ==
        \*         IF s = 1 THEN 0
        \*         ELSE IF _TETrace[s].gracePlan # _TETrace[s-1].gracePlan
        \*             THEN 1 + F[s-1] ELSE F[s-1]
        \*     IN F[_TEPosition - 1]
    ]

=============================================================================



Parsing and semantic processing can take forever if the trace below is long.
 In this case, it is advised to uncomment the module below to deserialize the
 trace from a generated binary file.

\*
\*---- MODULE PeerRollback_TETrace ----
\*EXTENDS IOUtils, PeerRollback, TLC
\*
\*trace == IODeserialize("PeerRollback_TTrace_1795407902.bin", TRUE)
\*
\*=============================================================================
\*

---- MODULE PeerRollback_TETrace ----
EXTENDS PeerRollback, TLC

trace == 
    <<
    ([gracePlan |-> (0 :> "empty" @@ 1 :> "empty" @@ 2 :> "empty" @@ 3 :> "drop"),moments |-> {},heldGrace |-> <<>>,applied |-> <<>>,haveGrace |-> 0,rewinds |-> 0,pending |-> 0..3,delivered |-> {},tick |-> 0,wrong |-> -1]),
    ([gracePlan |-> (0 :> "empty" @@ 1 :> "empty" @@ 2 :> "empty" @@ 3 :> "drop"),moments |-> {0},heldGrace |-> <<>>,applied |-> (0 :> "empty"),haveGrace |-> 0,rewinds |-> 0,pending |-> 0..3,delivered |-> {},tick |-> 1,wrong |-> -1]),
    ([gracePlan |-> (0 :> "empty" @@ 1 :> "empty" @@ 2 :> "empty" @@ 3 :> "drop"),moments |-> {0},heldGrace |-> (0 :> "empty"),applied |-> (0 :> "empty"),haveGrace |-> 1,rewinds |-> 0,pending |-> {1, 2, 3},delivered |-> {0},tick |-> 1,wrong |-> 0])
    >>
----


=============================================================================

---- CONFIG PeerRollback_TTrace_1795407902 ----
CONSTANTS
    MaxTick = 3
    Ahead = 2

INVARIANT
    _inv

CHECK_DEADLOCK
    \* CHECK_DEADLOCK off because of PROPERTY or INVARIANT above.
    FALSE

INIT
    _init

NEXT
    _next

CONSTANT
    _TETrace <- _trace

ALIAS
    _expression
=============================================================================
\* Generated on Mon Nov 23 04:25:02 UTC 2026