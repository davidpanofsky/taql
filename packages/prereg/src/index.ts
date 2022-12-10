import { Plugin } from '@envelop/core';
import { inspect } from 'util';

const preregisteredQueryResolver: Plugin = {
  // TODO fill in preregistered query resolution. We basically
  // need to transform requests that use preregistered query hashes
  // by swapping the hashes for actual queries before proceeding to
  // query parsing.
  //
  // If this can't be done here, we'll need to swap to using koa for our server
  // and add middlewhere there that can do it. If so, I will be annoyed because
  // we will have a mix of middleware-like things, some envelop plugins and some
  // koa plugins.
  onParse(params) {
    console.log(inspect({ onParse: params }));
    let context = params['context'];
    let extensions = context['params' as keyof typeof context]['extensions'];
    console.log(extensions);
    
    const maybePreregisteredId: string | null = extensions && extensions['preRegisteredQueryId'];
    if (maybePreregisteredId) {
      console.log("Got preregistered query id: " + maybePreregisteredId);
    }
  },
};

export const plugins: (Plugin | (() => Plugin))[] = [
  preregisteredQueryResolver,
];
