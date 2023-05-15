// eslint-disable-next-line no-restricted-properties
process.env.HOSTNAME = 'taql-12345';

import {
  getExecutor,
  testQuery,
  testQueryResult,
  testSchema,
} from '@taql/testing';
import { serverHostExtensionPlugin, subschemaExtensionsPlugin } from './index';
import { ExecutionResult } from '@graphql-tools/utils';
import { ForwardSubschemaExtensions } from './ForwardSubschemaExtensions';
import { stitchSchemas } from '@graphql-tools/stitch';

describe('serverHostExtensionPlugin', () => {
  it('should extend graphql response with server host name', async () => {
    const executor = getExecutor({
      schema: testSchema,
      plugins: [serverHostExtensionPlugin],
    });
    const result = await executor({ document: testQuery });
    // eslint-disable-next-line no-restricted-properties
    expect(result.extensions).toEqual({ serverHost: process.env.HOSTNAME });
  });
});

describe('subschemaExtensionsPlugin', () => {
  it('should forward subschema extensions', async () => {
    const stitchedSchema = stitchSchemas({
      subschemas: [
        {
          schema: testSchema,
          executor: () =>
            ({
              data: testQueryResult,
              extensions: { foo: 'bar', baz: 'qux' },
            } as ExecutionResult),
          transforms: [
            new ForwardSubschemaExtensions('test', ({ foo }) => ({ foo })),
          ],
        },
      ],
    });
    const executor = getExecutor({
      schema: stitchedSchema,
      plugins: [subschemaExtensionsPlugin],
    });
    const result = await executor({ document: testQuery });
    expect(result.extensions).toEqual({ test: { foo: 'bar' } });
  });
});
