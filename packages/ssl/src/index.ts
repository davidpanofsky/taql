import { SSL_PARAMS } from '@taql/config';

export type SslConfig = {
  cert: string;
  key: string;
  ca?: string;
};

const makeSslConfig = (): SslConfig | undefined => {
  const { cert, key, ca } = SSL_PARAMS;

  if (cert == undefined || key == undefined) {
    if ((cert == undefined) !== (key == undefined)) {
      console.error(
        'If CLIENT_CERT_PATH is set, CLIENT_KEY_PATH must also be set, and vice versa'
      );
    }
    return undefined;
  }

  return { cert, key, ca } as const;
};

export const SSL_CONFIG: SslConfig | undefined = makeSslConfig();
