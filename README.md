# taql

TA GraphQL service

## Enabling/Disabling TAQL via Cookie

The TAQL experience can be enabled or disabled explicitly via the `GraphQLNextGen` cookie in dev/preproduction.
Due to gitlab's sanitization of links, bookmarklets for setting/unsetting this cookie can be found in [this project's gitlab pages](https://dplat.pages.tamg.io/taql).

## Commands

- `yarn install --immutable` - install dependencies
- `yarn run build` - build the repository
- `yarn run start` - start the server
- `yarn run test` - run the unit tests

Alternatively, you could use `./scripts/server.bash` script to manage taql and run it as a background service. Run `yarn run server` to see the usage instructions. 

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

### OIDC-Lite Authentication

- `AUTH_MANAGER_KIND`: _(optional, default `undefined`)_ Set to `aws` or `oidc` to use OIDC-Lite mode.
- `AUTH_MANAGER_OIDC_TOKEN_PATH`: _(optional, default `/var/run/secrets/kubernetes.io/oidc`)_ Directory which contains oidc token(s) for delegated access. Default should work for k8s deployments of TAQL.
- `AUTH_MANAGER_EAGER_PROVIDER`: _(optional, default `false`)_ Whether to use `getEagerProvider()` or `getLazyProvider()`

### legacy graphql

- `LEGACY_GQL_URL`: _(optional, default `http://graphql.graphql-lapin.svc.kub.n.tripadvisor.com:4723`)_ The url of the legacy graphql service
- `LEGACY_GQL_OIDC_DOMAIN`: _(optional, default `siteops-dev.tamg.cloud`)_ The OIDC-Lite domain to use for authorization. This is only used for access via service gateway (see below).

#### legacy graphql via service gateway

By default, taql accesses legacy graphql directly, but it can also be configured to access it via service gateway (with IAM authorization):

```shell
AUTH_KIND=aws
LEGACY_GQL_OIDC_DOMAIN=siteops-dev.tamg.cloud
LEGACY_GQL_URL=https://ingress-gateway.platform.ml.tripadvisor.com/graphql
```

Access to legacy graphql via service gateway can also use an OIDC token taken from lapin with a configuration similar to:

```shell
AUTH_KIND=oidc
OIDC_TOKEN_PATH=/run/secrets/kubernetes.io/serviceaccount/token
LEGACY_GQL_OIDC_DOMAIN=siteops-dev.tamg.cloud
LEGACY_GQL_URL=https://ingress-gateway.platform.ml.tripadvisor.com/graphql
```

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

### Hints for running taql under docker locally

Using a combination of the following parameters can make running taql in docker locally much more plesant:

- `-p 4000:4000` _expose taql's port_
- `-v /etc/certs:/etc/certs` _use local ssl certs within taql_
- `-v ~/.aws:/root/.aws` _use local aws credentials/sso for OIDC-Lite_
- `-v ./oidc:/var/run/secrets/kubernetes.io/oidc` _use an oidc token (pulled from lapin) for OIDC-Lite_
