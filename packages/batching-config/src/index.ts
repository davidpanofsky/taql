/**
 * Strategies for combining queries into batches.
 */
export enum BatchingStrategy {
  /**
   * Barely permissive. Requests to upstream services triggered by the same
   * request to taql may be batched together.
   */
  BatchByInboundRequest = 'Request',

  // TODO establish some technique for noting when requests are combined, e.g.
  // logging trace ids or request ids that get batched together so traces
  // can be reconstructed. Alternately, look into the effects of sending multiple
  // trace and request id headers on a single request.
  /**
   * Moderately permissive. Requests to upstream services triggered by requests
   * to taql with identical headers may be batched together. Tracing headers
   * (e.g., `b3`, `x-b3-*`) and request unique headers (e.g., `x-guid`,
   * `x-request-id`) are excluded from this comparison. For example, if a user
   * agent makes two requests to taql in short succession, those requests will
   * typically have matching headers. If each request triggers a request
   * upstream to service Foo, we may batch those together. The principle here
   * is that if the upstream service relies on headers to determine the
   * contents of the response (say, for security purposes) and the batched
   * requests _have the same headers_, the upstream service will make the same
   * determination whether or not the requests are batched, so they _can_ be
   * batched.
   *
   * This is usually safe but may interfere with tracing, reporting, or
   * debugging by combining requests with different request ids or trace ids
   * into a single request with only _one_ of the sets of trace and request
   * ids.
   */
  BatchByUpstreamHeaders = 'Headers',
  /**
   * Note: This is incredibly dangerous. It has impressive performance
   * implications, but you should use this strategy in only the most
   * constrained, well-understood cases, or you will be the reason we're paying
   * out an expensive bug bounty. Your call.
   *
   * Most permissive. Requests to upstream services may be batched together
   * regardless of origin or headers. If the upstream service consumes headers
   * to provide security, this is incredibly dangerous, and should be used with
   * caution.
   */
  InsecurelyBatchIndiscriminately = 'Insecure',
}

/**
 * Styles of batch execution
 */
export enum BatchStyle {
  /**
   * Just for legacy graphql and other things shaped like it. Queries in a
   * batch will be added to an array, and that array will be set as a
   * 'requests' field on the request object. The responses will be in the
   * 'result' field on objects listed in a 'results' array on the top level
   * object.
   *
   * @deprecated This exists only to support legacy graphql. There's no reason
   * to go out of your way to shape an API like that today and require further
   * use of this style, so don't.
   */
  'Legacy' = 'Legacy',
  /**
   * Queries in a batch will be combined into fewer, larger queries (usually
   * exactly one query) before being sent upstream (potentially in parallel).
   * Each upstream request will use the headers from the first query in the
   * batch.
   */
  'Single' = 'Single',
  /**
   * Queries in a batch will be added to an array and that array will be sent
   * as the request object. The response will be an array at the top level.
   * The headers from the first query in the batch will be sent upstream.
   */
  'Array' = 'Array',
}

/*
 * @see Options
 * default values will be drawn from {@link defaultOptions}
 * minimum values will be drawn from {@link minimumOptions}
 * maximum values will be drawn from {@link maximumOptions}
 * */
type UnresolvedOptions = {
  maxSize?: number;
  wait: {
    queries?: number;
    millis?: number;
  };
};

export type Options = Readonly<{
  /**
   * The maximum number of queries to place in any single batch.
   */
  maxSize: number;
  /**
   * Configure the buffer used to provide queries for batching. When either
   * condition is met, the contents of the query buffer will be batched and
   * executed.
   */
  wait: {
    /**
     * Wait for up to this many queries to accumulate before batching. When the
     * InsecurelyBatchIndiscriminately {@link BatchingStrategy} is employed,
     * this must be the same as maxSize.
     */
    queries: number;
    /**
     * Wait up to this many milliseconds for queries to accumulate before
     * batching. Always waits at least one tick, so if upstream requests tend
     * to be dispatched simultaneously (likely, if the `BatchByInboundRequest`
     * {@link BatchingStrategy} is in effect), setting millis to 0 may be
     * effective and carry performance benefits.
     */
    millis: number;
  };
}>;

type BaseConfig = {
  /**
   * The strategy used to combine queries into batches
   */
  strategy: BatchingStrategy;
  /**
   * The style used to execute batches
   */
  style: BatchStyle;
};

export type UnresolvedBatchingConfig = UnresolvedOptions & BaseConfig;

export type BatchingConfig = Readonly<Options> & BaseConfig;

export const maximumOptions: Options = {
  /**
   * Large batches are more complicated and may overwhelm upstreams, or even taql's ability to
   * compose the upstream requests
   */
  maxSize: 100,
  wait: {
    /**
     * If the buffer is too large, it may place memory pressure on taql
     */
    queries: 200,
    /**
     * Waiting too long to kick off a request upstream is prima facie service
     * degradation, and, especially if the buffer is large or the upstream does
     * not receive many queries, we may frequently find ourselves waiting the
     * entire duration here.
     * Additionally, as long as we are waiting, we are holding the initial
     * request open and placing memory pressure on taql.
     */
    millis: 100,
  },
} as const;

export const minimumOptions: Options = {
  /**
   * I don't see why you would set a batch size of 2, but it's technically
   * batching.
   */
  maxSize: 2,
  wait: {
    /**
     * I don't see why you would set a batch size of 2, but it's technically
     * batching.
     */
    queries: 2,
    /**
     * Setting millis to 0 is occasionally useful
     */
    millis: 0,
  },
} as const;

export const defaultOptions: Options = {
  maxSize: 50,
  wait: {
    queries: 100,
    millis: 20,
  },
} as const;

const resolve = (
  min: number,
  max: number,
  defaultVal: number,
  val: number | undefined
): number => Math.max(min, Math.min(max, val != undefined ? val : defaultVal));

/** Apply all constraints and defaults to a batching configuration */
export const resolveConfig = (
  config: UnresolvedBatchingConfig | BatchingConfig
): BatchingConfig => {
  const strategy = config.strategy;

  const maxSize = resolve(
    minimumOptions.maxSize,
    maximumOptions.maxSize,
    defaultOptions.maxSize,
    config.maxSize
  );

  const queries =
    strategy == BatchingStrategy.InsecurelyBatchIndiscriminately
      ? maxSize
      : resolve(
          minimumOptions.wait.queries,
          maximumOptions.wait.queries,
          defaultOptions.wait.queries,
          config.wait.queries
        );
  return {
    ...config,
    maxSize,
    wait: {
      queries,
      millis: resolve(
        minimumOptions.wait.millis,
        maximumOptions.wait.millis,
        defaultOptions.wait.millis,
        config.wait.millis
      ),
    },
  };
};
