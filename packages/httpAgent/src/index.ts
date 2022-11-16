import { Agent } from 'http';
import { Agent as HttpsAgent } from 'https';
import { SSL_CONFIG } from '@taql/ssl';
import { SSL_PARAMS } from '@taql/config';

const makeAgentConfig = () => {
  const { rejectUnauthorized } = SSL_PARAMS;
  if (!rejectUnauthorized) {
    console.log(
      'fetch will not reject servers with bad certs by default. This is dangerous. Set SSL_REJECT_UNAUTHORIZED=true to rectify'
    );
  }
  return { rejectUnauthorized } as const;
};

export const agentConfig = makeAgentConfig();
export const httpsAgent: Agent | undefined =
  SSL_CONFIG &&
  new HttpsAgent({ ...SSL_CONFIG, ...agentConfig, keepAlive: true });
export const httpAgent: Agent = new Agent({ keepAlive: true });
