import fetch, { RequestInfo, RequestInit } from 'node-fetch';
import { Agent } from 'http';
import { Agent as HttpsAgent } from 'https';
import { readFileSync } from 'fs';

export type SslConfig = {
  cert: string;
  key: string;
  ca?: string;
  rejectUnauthorized: boolean;
};

const rfs = (file?: string): string | undefined => {
  if (file == undefined) {
    return undefined;
  }
  return readFileSync(file, 'utf-8');
};

const makeSslConfig = (): SslConfig | undefined => {
  const cert = rfs(process.env.CLIENT_CERT_PATH);
  const key = rfs(process.env.CLIENT_KEY_PATH);
  const ca = rfs(process.env.CLIENT_CERT_CA_PATH);
  const rejectUnauthorized = process.env.SSL_REJECT_UNAUTHORIZED !== 'false';
  if (!rejectUnauthorized) {
    console.log(
      'fetch will not reject servers with bad certs by default. This is dangerous. Set SSL_REJECT_UNAUTHORIZED=true to rectify'
    );
  }

  if (cert == undefined || key == undefined) {
    if ((cert == undefined) !== (key == undefined)) {
      console.error(
        'If CLIENT_CERT_PATH is set, CLIENT_KEY_PATH must also be set, and vice versa'
      );
    }
    return undefined;
  }

  return { cert, key, ca, rejectUnauthorized } as const;
};

export const sslConfig: SslConfig | undefined = makeSslConfig();

const agentConfig = {
  keepAlive: true,
} as const;

export const agent: Agent =
  sslConfig != undefined
    ? new HttpsAgent({
        ...sslConfig,
        ...agentConfig,
      })
    : new Agent(agentConfig);

export const fetchWithAgent = (url: RequestInfo, init?: RequestInit) =>
  fetch(url, { agent, ...(init || {}) });
