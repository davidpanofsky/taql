import * as yaml from 'js-yaml';
import { GITOPS_PARAMS, logger } from '@taql/config';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'fs';
import { loadSupergraph, makeSchema } from '@taql/schema';
import { inspect } from 'util';

// Env vars
// = This package =
// GITOPS_VALUES_FILE_PATH
// GITOPS_PATCH_FILE_PATH
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

type ValuesWithDigest = {
  taql: {
    schemaDigest?: string;
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
  patchFilePath: string | undefined,
  valuesFilePath: string,
  schemaProvider: () => Promise<Schema | undefined>,
  envVarToInject = 'SCHEMA_DIGEST'
): Promise<{ schemaId: string; digest: string }> {
  const schema = await schemaProvider();
  if (!schema) {
    throw new Error('Failed to build schema');
  }
  const digest = makeDigest(schema);

  // During migration away from kustomize, allow patch file to not exist
  if (
    patchFilePath &&
    existsSync(patchFilePath) &&
    lstatSync(patchFilePath).isFile()
  ) {
    // Load existing patch
    const patch = yaml.load(
      readFileSync(patchFilePath, 'utf-8')
    ) as Array<PatchItem>;

    let patchChanged = false;
    // Update digest if necessary
    patch.forEach((item: PatchItem) => {
      if (item.value.name == envVarToInject && item.value.value != digest) {
        item.value.value = digest;
        patchChanged = true;
      }
    });

    // Write patch if changes were made
    if (patchChanged) {
      writeFileSync(
        patchFilePath,
        yaml.dump(patch, {
          indent: 2,
        })
      );
    }
  } else if (!patchFilePath) {
    logger.info('Kustomize patch file not set, skipping');
  } else {
    logger.info(
      `Kustomize patch file ${patchFilePath} does not exist or is not a file, skipping`
    );
  }

  let valuesChanged = false;
  const values = yaml.load(
    readFileSync(valuesFilePath, 'utf-8')
  ) as ValuesWithDigest;

  if (!values['taql']) {
    throw new Error(
      `values file ${valuesFilePath} seems to be structured wrong; no 'taql' section found`
    );
  }

  if (values['taql']['schemaDigest'] != digest) {
    values['taql']['schemaDigest'] = digest;
    valuesChanged = true;
  }

  if (valuesChanged) {
    writeFileSync(
      valuesFilePath,
      yaml.dump(values, {
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
    !GITOPS_PARAMS.valuesFilePath ||
    !existsSync(GITOPS_PARAMS.valuesFilePath) ||
    !lstatSync(GITOPS_PARAMS.valuesFilePath).isFile()
  ) {
    throw new Error(
      `Can not write digest to ${GITOPS_PARAMS.valuesFilePath}, as it is not a file`
    );
  }

  let schemaProvider: () => Promise<Schema | undefined> = loadSchema;
  if (GITOPS_PARAMS.useDummyDigest) {
    console.log('RUNNING IN TEST MODE, USING DUMMY DIGEST');
    schemaProvider = dummySchema;
  }

  updateSchemaDigest(
    GITOPS_PARAMS.patchFilePath,
    GITOPS_PARAMS.valuesFilePath,
    schemaProvider
  ).then(function ({ schemaId, digest }) {
    console.log(`Digest (base64 encoded) for schema ${schemaId}: ${digest}`);
  });
}

main();
