# taql

TA GraphQL service

## Enabling/Disabling TAQL via Cookie
The TAQL experience can be enabled or disabled explicitly via the `GraphQLNextGen` cookie in dev/preproduction. 
Due to gitlab's sanitization of links, bookmarklets for setting/unsetting this cookie can be found in [this project's gitlab pages](dplat.pages.tamg.io/taql).


## Commands

- `yarn install --immutable` - install dependencies
- `yarn run build` - build the repository
- `yarn run server start` - start the service
- `yarn run test` - run the unit tests

## Environment variables

`taql` is configured via environment variables.

### Server

- `SERVER_PORT`: _(optional, default `4000`)_ - The port the server should listen on

### SSL, MTLS

- `CLIENT_CERT_PATH`: _(optional)_ path to the server's ssl cert
- `CLIENT_KEY_PATH`: _(optional)_ path to the server's ssl key
- `CLIENT_CERT_CA_PATH`: _(optional)_ path to the server's certificate authority.
- `SSL_REJECT_UNAUTHORIZED`: _(optional, default true)_ whether or not to fail calls to host with unrecognized certificates.

When both `CLIENT_CERT_PATH` and `CLIENT_KEY_PATH` are set, the server will use them (and `CLIENT_CERT_CA_PATH`, if set) to provide MTLS when connecting to other servers. Likewise, when both are set, the server will use them to sign responses to clients, and should be queried using the https protocol. If one or both values is not present, the server will not use MTLS for requests, and will not sign responses, so it should be queried using the http protocol.

### Automatic Persisted Query Cache

APQ always has an in-memory LRU cache:

- `AUTOMATIC_PERSISTED_QUERY_CACHE_SIZE`: _(optional, default 1000)_ size of the LRU cache.

Additionally, it can be configured to use redis as a second teir of the cache:

- `AUTOMATIC_PERSISTED_QUERY_REDIS_CLUSTER`: _(optional)_ hostname of the redis cluster.
- `AUTOMATIC_PERSISTED_QUERY_REDIS_INSTANCE`: _(optional)_ hostname of a standalone redis instance.
- `AUTOMATIC_PERSISTED_QUERY_REDIS_TTL`: _(optional, default 36000)_ TTL of APQ entries in redis.

If neither of `AUTOMATIC_PERSISTED_QUERY_REDIS_CLUSTER` or `AUTOMATIC_PERSISTED_QUERY_REDIS_INSTANCE` are specified, only the LRU cache is used.

For most development operations, the LRU cache is sufficient. If you need to test something with the redis backend, this can be accomplished by

1. Running redis in docker: `docker run -d -p 6379:6379 -p 8001:8001 redis/redis-stack:latest`
1. setting `AUTOMATIC_PERSISTED_QUERY_REDIS_INSTANCE=localhost`

### Stitching

#### legacy graphql

If `LEGACY_GQL_HOST` is not set, the legacy graphql service will not be stitched.

- `LEGACY_GQL_HOST`: _(optional)_ The host of the legacy graphql service
- `LEGACY_GQL_HTTP_PORT`: _(optional, default `4723`)_ The port to use when making http requests to the legacy graphql service
- `LEGACY_GQL_HTTPS_PORT`: _(optional, default `443`)_ The port to use when making https requests to the legacy graphql service.

## Building containers

### Build

```shell
VERSION=<version>
IMAGE=siteops-docker.maven.dev.tripadvisor.com/taql
docker build . -t "${IMAGE}:${VERSION}"
```

### Push

```shell
IMAGE=siteops-docker.maven.dev.tripadvisor.com/taql
docker login siteops-docker.maven.dev.tripadvisor.com
docker push ${IMAGE}
```
