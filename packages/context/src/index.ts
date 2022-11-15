import { HeadersContext, headerPlugin } from './headers';
import { Plugin } from '@envelop/core';
import { YogaInitialContext } from 'graphql-yoga';

export { copyHeaders } from './headers';

export type TaqlContext = YogaInitialContext & HeadersContext;

export const plugins: (Plugin<TaqlContext> | (() => Plugin<TaqlContext>))[] = [
  headerPlugin,
];
