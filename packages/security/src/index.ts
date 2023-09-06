import { GenericHeaders, getHeaderOrDefault } from '@taql/headers';
import { Plugin as YogaPlugin, createGraphQLError } from 'graphql-yoga';
import { SECURITY } from '@taql/config';

// Return true if we believe the client to be trustworthy. For now, clients are
// trustworthy by default unless they (implicitly, some proxy in-between, like
// the TRTOP dataapi graphql endpoint) tell us differently using headers. TODO
// integrate workload authentication via oidc or whatever's in vogue at TA by
// the time we get around to it
const trustClient = (headers?: GenericHeaders): boolean =>
  getHeaderOrDefault(
    headers,
    'x-taql-trust-client',
    SECURITY.trustByDefault ? 'true' : 'false'
  ) === 'true';

export const useTaqlSecurity = (): YogaPlugin | undefined =>
  SECURITY.runUntrustedOperations
    ? undefined
    : {
        onParams({ request, params, setParams }) {
          if (!trustClient(request.headers)) {
            // Untrusted clients can only provide pre-registered queries.
            const { query, extensions, ...rest } = params;
            const preRegisteredQueryId = extensions?.preRegisteredQueryId;

            if (
              query &&
              // TODO(WP-4134) tripadvisor/web sends the preRegisteredQueryId in
              // the `query` as well, only for a period of compatibility with
              // TRTOP, as /data/graphql is rolled out DTM. Remove this
              // condition after the rollout is complete.
              query !== preRegisteredQueryId
            ) {
              throw createGraphQLError(
                'Arbitrary operations not available to untrusted clients'
              );
            }

            // Strip the `query` (if any, see the above TODO), and ensure that
            // the only extension permitted from untrusted clients is the
            // preRegisteredQueryId.
            setParams({ ...rest, extensions: { preRegisteredQueryId } });
          }
        },
      };
