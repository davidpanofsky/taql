import { resolve, resolvers } from './resolution';
import { config } from 'dotenv';
config();

// TODO: Remove all this one day. Legacy gql is just something we'll find in the schema
// repo and use a custom executor for.
export const LEGACY_GQL_PARAMS = resolve({
  host: {
    property: 'LEGACY_GQL_HOST',
    defaultTo: 'graphql.graphql-lapin.svc.kub.n.tripadvisor.com',
  },
  httpPort: {
    property: 'LEGACY_GQL_HTTPS_PORT',
    resolver: resolvers.nonNegativeInteger,
    defaultTo: 80,
  },
  httpsPort: {
    property: 'LEGACY_GQL_HTTPS_PORT',
    resolver: resolvers.nonNegativeInteger,
    defaultTo: 443,
  },
});

export const SSL_PARAMS = resolve({
  cert: { property: 'CLIENT_CERT_PATH', resolver: resolvers.fileContents },
  key: { property: 'CLIENT_KEY_PATH', resolver: resolvers.fileContents },
  ca: { property: 'CLIENT_CERT_CA_PATH', resolver: resolvers.fileContents },
  rejectUnauthorized: {
    property: 'SSL_REJECT_UNAUTHORIZED',
    resolver: (val) => val !== 'false',
  },
});

export const SERVER_PARAMS = resolve({
  port: {
    property: 'SERVER_PORT',
    resolver: resolvers.nonNegativeInteger,
    defaultTo: 4000,
  },
});

export const PREREGISTERED_QUERY_PARAMS = resolve({
  max_cache_size: {
    property: 'PREREGISTERED_QUERY_CACHE_SIZE',
    resolver: resolvers.nonNegativeInteger,
    defaultTo: 2000
  },
  database_uri: {
    property: 'PREREGISTERED_QUERY_DB_URI',
    defaultTo: 'postgres://graphql_operations_ros@graphql-operations-ros.db.var.ml.tripadvisor.com'
  }
});
