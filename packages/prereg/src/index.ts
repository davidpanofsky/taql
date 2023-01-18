import { Plugin } from '@envelop/core';
const Client = require('pg-native');
import { inspect } from 'util';

// One single pool at the top level; it seems overly complicated to try to keep this inside the plugin object,
// especially considering there's no lifecycle method for plugin destruction, meaning we arent' really going to
// do anything smart with destroying the pool when the plugin goes away.
//
// Another approach would be to change the exported plugin to be a () => Plugin and initialize
// the pool during the call.  That would be sweet if we were passed some params at that time.
// TODO(smitchell): Climb to the top of the stack and see where this is initialized and if we have access to make
// configuration passable
const defaultDbUri =
  'postgres://graphql_operations_ros@graphql-operations-ros.db.var.ml.tripadvisor.com';

const connectionString =
  process.env['PREREGISTERED_QUERY_DB_URI'] || defaultDbUri; // eslint-disable-line no-restricted-properties
const db = new Client();

// envelop plugins' onParse method is synchronous and setting the document to a promise of the parsed query
// breaks things. Instead we just bite the bullet and do synchronous IO.

// Currently, within the alpine-node image libpq and node seem to link different openssl versions, leading to
// Segmentation Faults when using ssl to make connections.  Until this is fixed, disable ssl
const disableSsl = 'sslmode=disable';
db.connectSync(connectionString.endsWith(disableSsl) ? connectionString : `${connectionString}?${disableSsl}`);

function lookupQuery(queryId: string, db: typeof Client): Promise<string> {
  const res = db.querySync('SELECT code FROM t_graphql_operations WHERE id = $1', [queryId])
  return res.length > 0 ? res[0].code : '';
}

const preregisteredQueryResolver: Plugin = {
  // TODO fill in preregistered query resolution. We basically
  // need to transform requests that use preregistered query hashes
  // by swapping the hashes for actual queries before proceeding to
  // query parsing.
  //
  // If this can't be done here, we'll need to swap to using koa for our server
  // and add middleware there that can do it. If so, I will be annoyed because
  // we will have a mix of middleware-like things, some envelop plugins and some
  // koa plugins.
  onParse(params) {
    console.log(inspect({ onParse: params }));
    const context = params['context'];
    const extensions = context['params' as keyof typeof context]['extensions'];
    console.log(extensions);

    const maybePreregisteredId: string | null =
      extensions && extensions['preRegisteredQueryId'];
    if (maybePreregisteredId) {
      console.log(`Got preregistered query id: ${maybePreregisteredId}`);
      params.setParsedDocument(params.parseFn(lookupQuery(maybePreregisteredId, db)));
    }
  },
  onValidate(params) {
    console.log(inspect({ onValidate: params }));
  },
  async onExecute(params) {
    console.log(inspect({ onExecute: params }));
  },
  onContextBuilding(params) {
    console.log(inspect({ onContextBuilding: params }));
    console.log(params['context']);
  },
};

export const plugins: (Plugin | (() => Plugin))[] = [
  preregisteredQueryResolver,
];
