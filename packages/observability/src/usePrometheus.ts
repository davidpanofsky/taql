import {
  FillLabelsFnParams,
  createCounter,
  createHistogram,
  createSummary,
  usePrometheus,
} from '@graphql-yoga/plugin-prometheus';
import { defang } from '@taql/util.defang';
import promClient from 'prom-client';

const DefangedHistogram = defang(
  promClient.Histogram,
  'observe',
  'remove',
  'reset',
  'zero'
);
const DefangedCounter = defang(promClient.Counter, 'inc', 'remove', 'reset');
const DefangedSummary = defang(
  promClient.Summary,
  'observe',
  'remove',
  'reset'
);

const histoBucketsSec = [
  0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5,
];
const operationLabelNames = ['operationType', 'phase'];
const operationLabels = (params: FillLabelsFnParams) => ({
  operationType: params.operationType ?? 'unknown',
});

// Note: all phase histograms are in seconds, not milliseconds.
const phaseHisto = ({
  name,
  help,
  buckets = histoBucketsSec,
}: {
  name: string;
  help: string;
  buckets?: number[];
}) =>
  createHistogram({
    histogram: new DefangedHistogram({
      name,
      help,
      buckets,
      labelNames: operationLabelNames,
    }),
    fillLabelsFn: operationLabels,
  });

const evtCounter = ({ name, help }: { name: string; help: string }) =>
  createCounter({
    counter: new DefangedCounter({
      name,
      help,
      labelNames: ['operationName', 'operationType'],
    }),
    fillLabelsFn: (params: FillLabelsFnParams) => ({
      operationName: params.operationName ?? 'unknown',
      operationType: params.operationType ?? 'unknown',
    }),
  });

const errorCounter = ({ name, help }: { name: string; help: string }) =>
  createCounter({
    counter: new DefangedCounter({
      name,
      help,
      labelNames: ['operationName', 'operationType', 'phase'],
    }),
    fillLabelsFn: (params: FillLabelsFnParams) => ({
      operationName: params.operationName ?? 'unknown',
      operationType: params.operationType ?? 'unknown',
      phase: params.error?.message?.startsWith('Variable')
        ? 'variables'
        : params.errorPhase ?? 'unknown',
    }),
  });

export function usePreconfiguredPrometheus() {
  return usePrometheus({
    // Options specified by @graphql-yoga/plugin-prometheus
    // disabled because we track this via koa middleware, before the request gets to yoga
    http: false,
    // Options passed on to @envelop/prometheus
    // https://the-guild.dev/graphql/envelop/plugins/use-prometheus
    // all optional, and by default, all set to false
    // Note: all phase histograms are in seconds, not milliseconds.
    execute: phaseHisto({
      name: 'taql_envelop_phase_execute',
      help: 'Time (sec) spent running the GraphQL execute function',
    }),
    // requires `execute` to be enabled
    requestCount: evtCounter({
      name: 'taql_envelop_request',
      help: 'Counts the amount of GraphQL requests executed through Envelop',
    }),
    // requires `execute` to be enabled
    requestSummary: createSummary({
      summary: new DefangedSummary({
        name: 'taql_envelop_request_time_summary',
        help: 'Summary to measure the time (sec) to complete GraphQL operations',
        labelNames: operationLabelNames,
      }),
      fillLabelsFn: (params) => ({
        operationType: params.operationType ?? 'unknown',
      }),
    }),
    parse: phaseHisto({
      name: 'taql_envelop_phase_parse',
      help: 'Time (sec) spent running the GraphQL parse function',
    }),
    validate: phaseHisto({
      name: 'taql_envelop_phase_validate',
      help: 'Time (sec) spent running the GraphQL validate function',
    }),
    // no labels on this one. We don't do appreciable amounts of context buliding and it doesn't vary by operation anyhow.
    contextBuilding: createHistogram({
      histogram: new DefangedHistogram({
        name: 'taql_envelop_phase_context',
        help: 'Time (sec) spent building the GraphQL context',
        buckets: histoBucketsSec,
      }),
      fillLabelsFn: () => ({}),
    }),
    errors: errorCounter({
      name: 'taql_envelop_error_result',
      help: 'Counts the number of errors reported from all phases',
    }),
    endpoint: '/worker_metrics',
    // These have potential to slow everything down, so we disable them
    deprecatedFields: false,
    resolvers: false,
  });
}
