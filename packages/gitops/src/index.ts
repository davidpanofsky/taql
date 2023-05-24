import * as yaml from 'js-yaml';
import { SchemaDigest, makeSchemaWithDigest } from '@taql/schema';
import { lstatSync, readFileSync, writeFileSync } from 'fs';
import { GITOPS_PARAMS } from '@taql/config';

// Env vars
// = This package =
// GITOPS_FILE_TO_PATCH
//
// = Schema generation =
// LEGACY_GQL_HOST
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

type Digest = {
  digest: SchemaDigest;
};

/**
 * Encode a SchemaDigest into a base64 string that can be injected into deployment manifests
 */
function encodeDigest(digest: SchemaDigest): string {
  return Buffer.from(`${digest.legacyHash}_${digest.manifest}`).toString(
    'base64'
  );
}

async function updateSchemaDigest(
  patchFilePath: string,
  digestProvider: () => Promise<Digest | undefined> = makeSchemaWithDigest,
  envVarToInject = 'SCHEMA_DIGEST'
): Promise<{ digest: SchemaDigest; encoded: string }> {
  const result = await digestProvider();
  if (!result) {
    throw new Error('Failed to build schema');
  }
  const encodedDigest = encodeDigest(result.digest);

  // nodegit doesn't compile on my mac, so we won't use that and will instead just use a standard git installation
  // Load existing patch
  const patch = yaml.load(
    readFileSync(patchFilePath, 'utf-8')
  ) as Array<PatchItem>;

  let changed = false;
  // Update digest if necessary
  patch.forEach((item: PatchItem) => {
    if (
      item.value.name == envVarToInject &&
      item.value.value != encodedDigest
    ) {
      item.value.value = encodedDigest;
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

  return { digest: result.digest, encoded: encodedDigest };
}

// For testing
async function dummyDigest(): Promise<Digest> {
  return {
    digest: {
      legacyHash: Math.random().toString(36).substr(2, 10),
      manifest: '',
    },
  };
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

  let digestProvider: () => Promise<Digest | undefined> = makeSchemaWithDigest;
  if (GITOPS_PARAMS.useDummyDigest) {
    console.log('RUNNING IN TEST MODE, USING DUMMY DIGEST');
    digestProvider = dummyDigest;
  }

  updateSchemaDigest(GITOPS_PARAMS.patchFilePath, digestProvider).then(
    function (result) {
      console.log(`Digest (base64 encoded): ${result.encoded}`);
    }
  );
}

main();