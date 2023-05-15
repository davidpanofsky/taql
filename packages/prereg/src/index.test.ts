import {
  getExecutor,
  testMutation,
  testQuery,
  testSchema,
} from '@taql/testing';
import { mutatedFieldsExtensionPlugin } from './index';

describe('mutatedFieldsExtensionPlugin', () => {
  it('should not extend graphql response when executing query', async () => {
    const executor = getExecutor({
      schema: testSchema,
      plugins: [mutatedFieldsExtensionPlugin],
    });
    const result = await executor({ document: testQuery });
    expect(result.extensions).toEqual(undefined);
  });
  it('should extend graphql response when executing mutation', async () => {
    const executor = getExecutor({
      schema: testSchema,
      plugins: [mutatedFieldsExtensionPlugin],
    });
    const result = await executor({ document: testMutation });
    expect(result.extensions).toEqual({ mutatedFields: ['upvotePost'] });
  });
});
