import { Duration, Effect, Exit, Scope } from "effect";

import type { Loaded } from "../asset";

/**
 * The service a `Content`'s or an `Asset`'s `layer` provides: a `load` that runs `load` on its
 * first use, keeps its first success for as long as the layer's scope is open, and runs it again
 * after a failure. Callers at the same time share one run, which is interrupted only once every
 * one of them has left, and a run that was interrupted is kept by no one.
 *
 * `release` frees the kept value when the scope closes. The run is not the scope's, so it can
 * succeed after the scope closed: its value is then freed at once, since a closed scope runs a
 * finalizer as it is added. The value is handed to the scope as the run exits, so no
 * interruption comes between a success and its release.
 *
 * `span` names each `load` in a trace: the declaration's `<Name>.load`, so a trace shows a load
 * that waited on another's run as well as the one that ran. The context `load` requires is taken
 * once, here, so the service's `load` requires none of it.
 */
export const makeLoaded: <A, E, R>(
  span: string,
  load: Effect.Effect<A, E, R>,
  release?: (value: A) => void
) => Effect.Effect<Loaded<A, E>, never, R | Scope.Scope> = Effect.fnUntraced(
  function* <A, E, R>(
    span: string,
    load: Effect.Effect<A, E, R>,
    release?: (value: A) => void
  ) {
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<R>();
    const kept = yield* Effect.cachedWithTTL(
      load.pipe(
        Effect.provideContext(context),
        Effect.onExit((exit) =>
          release === undefined || Exit.isFailure(exit)
            ? Effect.void
            : Scope.addFinalizer(
                scope,
                Effect.sync(() => release(exit.value))
              )
        )
      ),
      (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero)
    );
    return { load: Effect.withSpan(kept, span) };
  }
);
