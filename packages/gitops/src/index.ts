import * as yaml from 'js-yaml';
import { loadSupergraph, makeSchema } from '@taql/schema';
import { lstatSync, readFileSync, writeFileSync } from 'fs';
import { GITOPS_PARAMS } from '@taql/config';
import { inspect } from 'util';

// Env vars
// = This package =
// GITOPS_FILE_TO_PATCH
//
// = Schema generation =
// LEGACY_GQL_URL
// CLIENT_CERT_PATH
// CLIENT_KEY_PATH
// CLIENT_CERT_CA_PATH
//

/*
  patches look like:
  [
    {
      op: 'add',
      path: '/spec/template/spec/containers/0/env/-',
      value: { name: 'SCHEMA_DIGEST', value: 'foo' }
    }
  ]
*/
type PatchItem = {
  op: string;
  path: string;
  value: {
    name: string;
    value: string;
  };
};

// we're only interested in the ID part of the schema.
type Schema = { id: string };

/**
 * Encode a SchemaDigest into a base64 string that can be injected into deployment manifests
 */
function makeDigest(schema: Schema): string {
  return Buffer.from(schema.id).toString('base64');
}

async function updateSchemaDigest(
  patchFilePath: string,
  schemaProvider: () => Promise<Schema | undefined>,
  envVarToInject = 'SCHEMA_DIGEST'
): Promise<{ schemaId: string; digest: string }> {
  const schema = await schemaProvider();
  if (!schema) {
    throw new Error('Failed to build schema');
  }
  const digest = makeDigest(schema);

  // nodegit doesn't compile on my mac, so we won't use that and will instead just use a standard git installation
  // Load existing patch
  const patch = yaml.load(
    readFileSync(patchFilePath, 'utf-8')
  ) as Array<PatchItem>;

  let changed = false;
  // Update digest if necessary
  patch.forEach((item: PatchItem) => {
    if (item.value.name == envVarToInject && item.value.value != digest) {
      item.value.value = digest;
      changed = true;
    }
  });

  // Write patch if changes were made
  if (changed) {
    writeFileSync(
      patchFilePath,
      yaml.dump(patch, {
        indent: 2,
      })
    );
  }

  return { schemaId: schema.id, digest };
}

// For testing
async function dummySchema(): Promise<Schema> {
  return {
    id: Math.random().toString(36).substring(2, 10),
  };
}
async function loadSchema(): Promise<Schema> {
  const stitchResult = await makeSchema(await loadSupergraph());
  if ('success' in stitchResult) {
    return stitchResult.success;
  } else if ('partial' in stitchResult) {
    const message = `Partial schema. Validation errors in schema: ${inspect(
      stitchResult.partial.validationErrors
    )}`;
    if (GITOPS_PARAMS.allowPartialSchema) {
      console.error(message);
      return stitchResult.partial;
    } else {
      throw new Error(message);
    }
  } else {
    throw new Error(
      `Unable to produce schema: ${inspect(
        stitchResult.error.validationErrors
      )}`
    );
  }
}

function main() {
  if (
    !GITOPS_PARAMS.patchFilePath ||
    !lstatSync(GITOPS_PARAMS.patchFilePath).isFile()
  ) {
    throw new Error(
      `Can not write digest to ${GITOPS_PARAMS.patchFilePath}, as it is not a file`
    );
  }

  let schemaProvider: () => Promise<Schema | undefined> = loadSchema;
  if (GITOPS_PARAMS.useDummyDigest) {
    console.log('RUNNING IN TEST MODE, USING DUMMY DIGEST');
    schemaProvider = dummySchema;
  }

  updateSchemaDigest(GITOPS_PARAMS.patchFilePath, schemaProvider).then(
    function (result) {
      console.log(`Digest (base64 encoded): ${result}`);
    }
  );
}

main();
