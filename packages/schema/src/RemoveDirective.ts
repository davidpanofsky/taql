import { DelegationContext, Transform } from '@graphql-tools/delegate';
import { Kind, visit } from 'graphql';
import { ExecutionRequest } from '@graphql-tools/utils';

// eslint-disable-next-line  @typescript-eslint/no-explicit-any
type RemoveDirectiveTransformationContext = Record<string, any>;

/**
 * Transform which removes a given directive from queries to modified subschemas.
 * Example use case: removing query directies which are supported in a subschema but have been hoisted
 * to the federation level.
 * https://the-guild.dev/graphql/stitching/docs/transforms
 */
// eslint-disable-next-line  @typescript-eslint/no-explicit-any
export default class RemoveDirective<TContext = Record<string, any>>
  implements Transform<RemoveDirectiveTransformationContext, TContext>
{
  private readonly matcher: (directiveObj: {
    kind: string;
    name: { value: string };
  }) => boolean;

  constructor(directive: string) {
    this.matcher = (directiveObj) => directiveObj?.name?.value === directive;
  }

  public transformRequest(
    originalRequest: ExecutionRequest,
    delegationContext: DelegationContext<TContext>, // eslint-disable-line @typescript-eslint/no-unused-vars
    transformationContext: RemoveDirectiveTransformationContext // eslint-disable-line @typescript-eslint/no-unused-vars
  ): ExecutionRequest {
    const document = visit(originalRequest.document, {
      [Kind.FIELD]: {
        enter: (node) => {
          // Not all nodes have a directives field.
          if ('directives' in node && node.directives?.some(this.matcher)) {
            const directives = node.directives.filter(
              (directive) => !this.matcher(directive)
            );
            return {
              ...node,
              directives,
            };
          }
          return undefined;
        },
      },
    });

    return {
      ...originalRequest,
      document,
    };
  }
}
