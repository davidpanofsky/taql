# taql

TA Graphql service

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
