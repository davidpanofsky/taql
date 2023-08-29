import { SSL_PARAMS, logger } from '@taql/config';
import { Agent } from 'http';
import { Agent as HttpsAgent } from 'https';
import { SSL_CONFIG } from '@taql/ssl';
import { lookup } from 'lookup-dns-cache';

const makeAgentConfig = () => {
  const { rejectUnauthorized } = SSL_PARAMS;
  if (!rejectUnauthorized) {
    logger.warn(
      'fetch will not reject servers with bad certs by default. This is dangerous. Set SSL_REJECT_UNAUTHORIZED=true to rectify'
    );
  }
  return { rejectUnauthorized } as const;
};

// Inspiration from https://gitlab.dev.tripadvisor.com/tripadvisor/web/-/blob/master/platform/component-server/service/isolate-service-caller.ts#L137-142
const agentDefaults = {
  lookup,
  keepAlive: true,
  maxSockets: 128,
  maxFreeSockets: 16,
};

export const agentConfig = makeAgentConfig();

export const legacyHttpsAgent: Agent = new HttpsAgent({
  ...SSL_CONFIG,
  ...agentConfig,
  ...agentDefaults,
});

export const httpsAgent: Agent = new HttpsAgent({
  ...agentConfig,
  ...agentDefaults,
});

export const httpAgent: Agent = new Agent(agentDefaults);
