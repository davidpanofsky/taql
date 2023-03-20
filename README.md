# taql

TA Graphql service

## Requirements

### libpq

For postgres operations (e.g to resolve preregistered queries) we use `pg-native`, which requires `libpq` to build.

On Centos:

```
yum install postgresql-libs
```

The node `libpq` package might exercise newer g++ features than are supported by your installation. To upgrade on centos systems, use SCL:

```
# 1. Install a package with repository for your system:
$ sudo yum install centos-release-scl

# 2. Install the collection:
$ sudo yum install devtoolset-7

# 3. Start using software collections:
$ scl enable devtoolset-7 bash

# 4. Install libpq
$ yarn install
```

On Mac:

```
brew install libpq
# brew doesn't link into /usr/local/lib
ln -s /usr/local/opt/libpq/lib/libpq.5.dylib /usr/local/lib/libpq.5.dylib
```

## Commands

- `yarn install --immutable` - install dependencies
- `yarn run build` - build the repository
- `yarn run start` - start the service

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

### Stitching

#### legacy graphql

If `LEGACY_GQL_HOST` is not set, the legacy graphql service will not be stitched.

- `LEGACY_GQL_HOST`: _(optional)_ The host of the legacy graphql service
- `LEGACY_GQL_HTTP_PORT`: _(optional, default `80`)_ The port to use when making http requests to the legacy graphql service
- `LEGACY_GQL_HTTPS_PORT`: _(optional, default `443`)_ The port to use when making https requests to the legacy graphql service.

## Building containers

### Build

```
VERSION=<version>
IMAGE=siteops-docker.maven.dev.tripadvisor.com/taql
docker build . -t "${IMAGE}:${VERSION}"
```

### Push

```
IMAGE=siteops-docker.maven.dev.tripadvisor.com/taql
docker login siteops-docker.maven.dev.tripadvisor.com
docker push ${IMAGE}
```
