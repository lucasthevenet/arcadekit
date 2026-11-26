import { Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/http";

import { Failed as AssetFailed } from "../Assets.ts";
import type { LoaderShape } from "../Assets.ts";

// What a request that got no answer says: what was asked, and why.
const unanswered = (error: HttpClientError.HttpClientError): string => {
  const cause = error.reason.cause;
  return cause instanceof Error && cause.message !== ""
    ? `${error.message}: ${cause.message}`
    : error.message;
};

/**
 * Effect's `HttpClient` over `fetch`, asking for the address `resolve` makes
 * of an asset's URL. A failure names the URL as the game wrote it.
 * @internal
 */
export const fetchingFrom = (
  resolve: (url: string) => string
): LoaderShape => ({
  bytes: (url) =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(resolve(url));
      if (response.status < 200 || response.status >= 300) {
        return yield* new AssetFailed({
          url,
          message: `The server answered ${response.status}`,
          ...(response.status >= 500 ? { transient: true } : {}),
        });
      }
      return new Uint8Array(yield* response.arrayBuffer);
    }).pipe(
      Effect.catchTag("HttpClientError", (error) =>
        Effect.fail(
          new AssetFailed({
            url,
            message: unanswered(error),
            // The request got no answer, or its body stopped arriving.
            ...(error.reason._tag === "TransportError" ||
            error.reason._tag === "DecodeError"
              ? { transient: true }
              : {}),
          })
        )
      ),
      Effect.provide(FetchHttpClient.layer)
    ),
});

/**
 * What `Loader` is when nothing provides it. A path is read as `HttpClient`
 * reads it, from the page's address, or the process's in Node.
 * @internal
 */
export const fetching: LoaderShape = fetchingFrom((url) => url);
