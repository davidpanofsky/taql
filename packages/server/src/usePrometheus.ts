import {
  FillLabelsFnParams,
  createCounter,
  createHistogram,
  usePrometheus,
} from '@graphql-yoga/plugin-prometheus';
import promClient from 'prom-client';

const histoBucketsSec = [
  0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5,
];
const operationLabelNames = ['operationName', 'operationType', 'phase'];
const operationLabels = (params: FillLabelsFnParams) => ({
  operationName: params.operationName ?? 'unknown',
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
    histogram: new promClient.Histogram({
      name,
      help,
      buckets,
      labelNames: operationLabelNames,
    }),
    fillLabelsFn: operationLabels,
  });

const evtCounter = ({ name, help }: { name: string; help: string }) =>
  createCounter({
    counter: new promClient.Counter({
      name,
      help,
      labelNames: operationLabelNames,
    }),
    fillLabelsFn: operationLabels,
  });

const errorCounter = ({ name, help }: { name: string; help: string }) =>
  createCounter({
    counter: new promClient.Counter({
      name,
      help,
      labelNames: ['operationName', 'operationType', 'errorPhase'],
    }),
    fillLabelsFn: (params: FillLabelsFnParams) => ({
      operationName: params.operationName ?? 'unknown',
      operationType: params.operationType ?? 'unknown',
      errorPhase: params.error?.message?.startsWith('Variable')
        ? 'validate'
        : params.errorPhase ?? 'unknown',
    }),
  });

export const preconfiguredUsePrometheus = usePrometheus({
  // Options specified by @graphql-yoga/plugin-prometheus
  // Note: http histogram metric is in milliseconds, not seconds.
  http: createHistogram({
    histogram: new promClient.Histogram({
      name: 'taql_http_duration_ms',
      help: 'Time spent on HTTP connection',
      buckets: histoBucketsSec.map((x) => x * 1000),
      labelNames: ['operationType', 'operationName', 'statusCode'],
    }),
    fillLabelsFn: (params, { response }) => ({
      operationType: params.operationType ?? 'unknown',
      operationName: params.operationName ?? 'unknown',
      statusCode: response.status,
    }),
  }),
  // Options passed on to @envelop/prometheus
  // https://the-guild.dev/graphql/envelop/plugins/use-prometheus
  // all optional, and by default, all set to false
  // Note: all phase histograms are in seconds, not milliseconds.
  execute: phaseHisto({
    name: 'taql_envelop_phase_execute',
    help: 'Time spent running the GraphQL execute function',
  }),
  // requires `execute` to be enabled
  requestCount: evtCounter({
    name: 'taql_envelop_request',
    help: 'Counts the amount of GraphQL requests executed through Envelop',
  }),
  // requires `execute` to be enabled
  requestSummary: true,
  parse: phaseHisto({
    name: 'taql_envelop_phase_parse',
    help: 'Time spent running the GraphQL parse function',
  }),
  validate: phaseHisto({
    name: 'taql_envelop_phase_validate',
    help: 'Time spent running the GraphQL validate function',
  }),
  // no labels on this one. We don't do appreciable amounts of context buliding and it doesn't vary by operation anyhow.
  contextBuilding: createHistogram({
    histogram: new promClient.Histogram({
      name: 'taql_envelop_phase_context',
      help: 'Time spent building the GraphQL context',
      buckets: histoBucketsSec,
    }),
    fillLabelsFn: () => ({}),
  }),
  errors: errorCounter({
    name: 'taql_envelop_error_result',
    help: 'Counts the number of errors reported from all phases',
  }),
  // leave deprecated fields alone, this one is useful as is and should be low-volume.
  deprecatedFields: true,
  endpoint: '/worker_metrics',
});
