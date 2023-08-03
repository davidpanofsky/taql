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
        onParams(args) {
          const trusted = trustClient(args.request.headers);
          const { query } = args.params;
          if (
            !trusted &&
            // Untrusted clients cannot provide arbitrary queries. They must use
            // persisted queries or preregistered queries (specified by identifiers in
            // extensions)
            query != undefined &&
            query !== ''
          ) {
            throw createGraphQLError(
              'Arbitrary operations not available to untrusted clients'
            );
          }
        },
      };
