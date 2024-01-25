import { ExecutionRequest, ExecutionResult } from '@graphql-tools/utils';
import {
  GraphQLSchemaWithContext,
  YogaInitialContext,
  YogaServerOptions,
  createSchema,
  createYoga,
} from 'graphql-yoga';
import { buildHTTPExecutor } from '@graphql-tools/executor-http';
import { parse } from 'graphql';

function assertSingleValue<TValue extends object>(
  value: TValue | AsyncIterable<TValue>
): asserts value is TValue {
  if (Symbol.asyncIterator in value) {
    throw new Error('Expected single value');
  }
}
export const getExecutor = <
  TServerContext extends Record<string, unknown> = Record<string, never>,
  TUserContext extends Record<string, unknown> = Record<string, never>,
>(
  options: YogaServerOptions<TServerContext, TUserContext>
): ((req: ExecutionRequest) => Promise<ExecutionResult>) => {
  const yoga = createYoga(options);
  const httpExecutor = buildHTTPExecutor({
    fetch: yoga.fetch,
  });
  return async function executor(request: ExecutionRequest) {
    const result = await httpExecutor(request);
    assertSingleValue(result);
    return result;
  };
};

const authors = [
  { id: 1, firstName: 'James', lastName: 'Smith' },
  { id: 2, firstName: 'John', lastName: 'Miller' },
  { id: 3, firstName: 'Richard', lastName: 'Brown' },
];

const posts = [
  { id: 1, authorId: 1, title: 'Introduction to GraphQL', votes: 2 },
  { id: 2, authorId: 2, title: 'Queries and Mutations', votes: 3 },
  { id: 3, authorId: 2, title: 'Schemas and Types', votes: 7 },
  { id: 4, authorId: 3, title: 'Advanced GraphQL', votes: 1 },
];

export const testSchema = <
  GraphQLSchemaWithContext<Record<string, never> & YogaInitialContext>
>createSchema({
  typeDefs: /* GraphQL */ `
    type Author {
      id: Int!
      firstName: String
      lastName: String
      posts: [Post]
    }

    type Post {
      id: Int!
      title: String
      author: Author
      votes: Int
    }

    type Query {
      posts: [Post]
      author(id: Int!): Author
    }

    type Mutation {
      upvotePost(postId: Int!): Post
    }
  `,
  resolvers: {
    Query: {
      posts: () => posts,
      author: (_, { id }) => authors.find((author) => author.id === id),
    },

    Mutation: {
      upvotePost(_, { postId }) {
        const post = posts.find((post) => post.id === postId);
        if (!post) {
          throw new Error(`Couldn't find post with id ${postId}`);
        }
        return { ...post, votes: post.votes + 1 };
      },
    },

    Author: {
      posts: (author) => posts.filter((post) => post.authorId === author.id),
    },

    Post: {
      author: (post) => authors.find((author) => author.id === post.authorId),
    },
  },
});

export const testQuery = parse(/* GraphQL */ `
  query GetAllPosts {
    posts {
      id
      title
      votes
      author {
        id
        firstName
        lastName
      }
    }
  }
`);

export const testQueryResult = { posts };

export const testMutation = parse(/* GraphQL */ `
  mutation UpvotePost {
    upvotePost(postId: ${posts[0].id}) {
      votes
    }
  }
`);

export const testMutationResult = {
  votes: posts[0].votes + 1,
};
