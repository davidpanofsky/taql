import { LogLevel, createLogger } from '@graphql-yoga/logger';
import { resolve, resolvers } from './resolution';
import { config } from 'dotenv';
import { hostname } from 'os';

config();

const logLevel = resolve({
  level: {
    property: 'LOG_LEVEL',
    resolver: resolvers.logLevel,
  },
});
export const logger = createLogger(logLevel.level as LogLevel);
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
  batchMaxSize: {
    /* Matches MAX_MERGED_STEPS in legacy graphql
     * https://gitlab.dev.tripadvisor.com/dplat/graphql/-/blob/master/src/main/params/common.ini#L555
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
