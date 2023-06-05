import { format, loggers, transports } from 'winston';
import { resolve, resolvers } from './resolution';
import { availableParallelism } from 'node:os';
import cluster from 'node:cluster';
import { config } from 'dotenv';
import { hostname } from 'os';
import { logFmtFormat } from 'winston-logfmt';

config();

const loggerConfig = resolve({
  console: {
    property: 'LOG_CONSOLE',
    resolver: resolvers.booleanFromString,
    defaultTo: true,
  },
  level: {
    property: 'LOG_LEVEL',
    defaultTo: process.env.NODE_ENV === 'test' ? 'error' : 'info',
  },
});

//export const logger = createLogger({
loggers.add('access', {
  defaultMeta: { worker: cluster.worker ? cluster.worker.id : 0 },
  exitOnError: true,
  transports: new transports.Console({
    handleExceptions: false,
    handleRejections: false,
    level: 'info',
    stderrLevels: [],
    format: format.combine(
      loggerConfig.console
        ? format.combine(format.colorize(), format.simple())
        : format.combine(
            format.timestamp(),
            format.uncolorize(),
            logFmtFormat()
          )
    ),
  }),
});
loggers.add('app', {
  defaultMeta: { worker: cluster.worker ? cluster.worker.id : 0 },
  exitOnError: true,
  transports: new transports.Console({
    handleExceptions: !loggerConfig.console,
    handleRejections: !loggerConfig.console,
    level: loggerConfig.level,
    stderrLevels: ['debug', 'info', 'warn', 'error', 'critical'],
    format: format.combine(
      format.errors({ stack: true }),
      loggerConfig.console
        ? format.combine(format.colorize(), format.simple())
        : format.combine(
            format.timestamp(),
            format.uncolorize(),
            logFmtFormat()
          )
    ),
  }),
});
export const logger = loggers.get('app');
export const accessLogger = loggers.get('access');

// TODO: Remove all this one day. Legacy gql is just something we'll find in the schema
// repo and use a custom executor for.
export const LEGACY_GQL_PARAMS = resolve({
  host: {
    property: 'LEGACY_GQL_HOST',
    defaultTo: 'graphql.graphql-lapin.svc.kub.n.tripadvisor.com',
  },
  httpPort: {
    property: 'LEGACY_GQL_HTTP_PORT',
    resolver: resolvers.nonNegativeInteger,
    defaultTo: 4723,
  },
  httpsPort: {
    property: 'LEGACY_GQL_HTTPS_PORT',
    resolver: resolvers.nonNegativeInteger,
    defaultTo: 443,
  },
  maxTimeout: {
    property: 'LEGACY_GQL_TIMEOUT',
    resolver: resolvers.nonNegativeInteger,
    defaultTo: 5000,
  },
  batchMaxSize: {
    /* Matches MAX_BATCH_SIZE in legacy graphql
     * https://gitlab.dev.tripadvisor.com/dplat/graphql/-/blob/9f963cca39936c6ba53421a2063bcc5a92d1990a/src/main/java/com/tripadvisor/service/graphql/GraphQlEndpoint.java#L56
     */
    property: 'LEGACY_GQL_BATCH_MAX_SIZE',
    resolver: resolvers.nonNegativeInteger,
    defaultTo: 250,
  },
  batchWaitQueries: {
    property: 'LEGACY_GQL_BATCH_WAIT_QUERIES',
    resolver: resolvers.nonNegativeInteger,
    defaultTo: 200,
  },
  batchWaitMillis: {
    property: 'LEGACY_GQL_BATCH_WAIT_MILLIS',
    resolver: resolvers.nonNegativeInteger,
    defaultTo: 20,
  },
});

export const EXECUTION_TIMEOUT_PARAMS = resolve({
  // When serving a request with no timeout specified (via x-timeout header),
  // apply this timeout to request processing
  defaultExecutionTimeoutMillis: {
    property: 'DEFAULT_EXECUTION_TIMEOUT_MILLIS',
    resolver: resolvers.nonNegativeInteger,
    defaultTo: 1000,
  },
  // The maximum timeout to apply to request processing, regardless timeouts
  // specified by the request.
  maxExecutionTimeoutMillis: {
    property: 'DEFAULT_EXECUTION_TIMEOUT_MILLIS',
    resolver: resolvers.nonNegativeInteger,
    defaultTo: 3500,
  },
  // When computing timeouts for upstream calls, subtract this amount from the
  // timeout active on the current request to ensure we have time to assemble
  // our response.
  executionPaddingMillis: {
    property: 'EXECUTION_PADDING_MILLIS',
    resolver: resolvers.nonNegativeInteger,
    defaultTo: 25,
  },
});

export const UPSTREAM_TIMEOUT_PARAMS = resolve({
  // When setting the x-timeout header on upstream calls, subtract this amount
  // of time from the time remaining in the current request (to pad for network
  // overhead)
  upstreamTimeoutPaddingMillis: {
    property: 'UPSTREAM_TIMEOUT_PADDING_MILLIS',
    resolver: resolvers.nonNegativeInteger,
    defaultTo: 25,
  },
  // Below this threshold, do not pad the x-timeout header, just hope the
  // request completes in time.
  upstreamTimeoutPaddingThreshold: {
    property: 'UPSTREAM_TIMEOUT_PADDING_THRESHOLD',
    resolver: resolvers.nonNegativeInteger,
    defaultTo: 25,
  },
  // Default maximum time to allot upstream calls, no matter how much time is
  // left to serve the current request, unless the upstream is configured
  // differently.
  softMaxUpstreamTimeoutMillis: {
    property: 'SOFT_MAX_UPSTREAM_TIMEOUT_MILLIS',
    resolver: resolvers.nonNegativeInteger,
    defaultTo: 350,
  },
  // Maximum time to allot upstream calls, no matter how much time is left to
  // serve the current request or how the upstream is configured.
  hardMaxUpstreamTimeoutMillis: {
    property: 'HARD_MAX_UPSTREAM_TIMEOUT_MILLIS',
    resolver: resolvers.nonNegativeInteger,
    defaultTo: 2500,
  },
});

export const SSL_PARAMS = resolve({
  cert: { property: 'CLIENT_CERT_PATH', resolver: resolvers.fileContents },
  key: { property: 'CLIENT_KEY_PATH', resolver: resolvers.fileContents },
  ca: { property: 'CLIENT_CERT_CA_PATH', resolver: resolvers.fileContents },
  rejectUnauthorized: {
    property: 'SSL_REJECT_UNAUTHORIZED',
    resolver: resolvers.booleanFromString,
    defaultTo: true,
  },
});

export const SERVER_PARAMS = resolve({
  port: {
    property: 'SERVER_PORT',
    resolver: resolvers.nonNegativeInteger,
    defaultTo: 4000,
  },
  batchLimit: {
    property: 'SERVER_BATCH_LIMIT',
    resolver: resolvers.nonNegativeInteger,
    defaultTo: 2000,
  },
  hostname: {
    property: 'HOSTNAME',
    defaultTo: hostname(),
  },
  clusterParallelism: {
    property: 'CLUSTER_PARALLELISM',
    defaultTo:
      availableParallelism instanceof Function ? availableParallelism() : 1,
    resolver: resolvers.nonNegativeInteger,
  },
  svcoWorker: {
    property: 'SVCO_WORKER',
    resolver: resolvers.booleanFromString,
    defaultTo: false,
  },
});

export const ENABLE_FEATURES = resolve({
  debugExtensions: {
    property: 'ENABLE_DEBUG_EXTENSIONS',
    resolver: resolvers.booleanFromString,
    defaultTo: process.env.NODE_ENV === 'production' ? false : true,
  },
  graphiql: {
    property: 'ENABLE_GRAPHIQL',
    resolver: resolvers.booleanFromString,
    defaultTo: process.env.NODE_ENV === 'production' ? false : true,
  },
  introspection: {
    property: 'ENABLE_INTROSPECTION',
    resolver: resolvers.booleanFromString,
    defaultTo: process.env.NODE_ENV === 'production' ? false : true,
  },
  serviceOverrides: {
    property: 'ENABLE_SERVICE_OVERRIDES',
    resolver: resolvers.booleanFromString,
    defaultTo: process.env.NODE_ENV === 'production' ? false : true,
  },
});

export const PREREGISTERED_QUERY_PARAMS = resolve({
  maxCacheSize: {
    property: 'PREREGISTERED_QUERY_CACHE_SIZE',
    resolver: resolvers.nonNegativeInteger,
    defaultTo: 2000,
  },
  databaseUri: {
    property: 'PREREGISTERED_QUERY_DB_URI',
    defaultTo:
      'postgres://graphql_operations_ros@graphql-operations-ros.db.var.ml.tripadvisor.com',
  },
  pgUseSsl: {
    property: 'PREREGISTERED_QUERY_USE_SSL',
    resolver: resolvers.booleanFromString,
    defaultTo: false,
  },
  pgSslKeyPath: {
    property: 'PGSSLKEY',
    defaultTo: '/etc/certs/cert.key',
  },
  pgSslCertPath: {
    property: 'PGSSLCERT',
    defaultTo: '/etc/certs/cert.pem',
  },
  pgSslCaCertPath: {
    property: 'PGSSLROOTCERT',
    defaultTo: '/etc/certs/root.pem',
  },
  sslRejectUnauthorized: {
    property: 'PREREGISTERED_QUERY_REJECT_UNAUTHORIZED',
    resolver: resolvers.booleanFromString,
    defaultTo: true,
  },
});

export const AUTOMATIC_PERSISTED_QUERY_PARAMS = resolve({
  redisCluster: {
    property: 'AUTOMATIC_PERSISTED_QUERY_REDIS_CLUSTER',
    defaultTo: undefined,
  },
  redisInstance: {
    property: 'AUTOMATIC_PERSISTED_QUERY_REDIS_INSTANCE',
    defaultTo: undefined,
  },
  redisTTL: {
    property: 'AUTOMATIC_PERSISTED_QUERY_REDIS_TTL',
    resolver: resolvers.nonNegativeInteger,
    defaultTo: 36_000,
  },
  memCacheSize: {
    property: 'AUTOMATIC_PERSISTED_QUERY_CACHE_SIZE',
    resolver: resolvers.nonNegativeInteger,
    defaultTo: 1000,
  },
});

export const PROM_PARAMS = resolve({
  prefix: {
    property: 'PROM_PREFIX',
    defaultTo: 'taql_primary_',
  },
  workerPrefix: {
    property: 'PROM_WORKER_PREFIX',
    defaultTo: 'taql_',
  },
});

export const TRACING_PARAMS = resolve({
  zipkinUrl: {
    property: 'TRACING_ZIPKIN_URL',
    defaultTo: undefined,
  },
  useBatchingProcessor: {
    property: 'TRACING_USE_BATCHING_PROCESSOR',
    resolver: resolvers.booleanFromString,
    defaultTo: false,
  },
});

export const GITOPS_PARAMS = resolve({
  patchFilePath: {
    property: 'GITOPS_PATCH_FILE_PATH',
    defaultTo: undefined,
  },
  useDummyDigest: {
    property: 'GITOPS_USE_DUMMY_DIGEST',
    resolver: resolvers.booleanFromString,
    defaultTo: false,
  },
});
