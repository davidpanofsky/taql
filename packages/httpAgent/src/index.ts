import { SSL_PARAMS, logger } from '@taql/config';
import { Agent } from 'http';
// TODO fix modules so we can import this thing.
//import CacheableLookup from 'cacheable-lookup';
import { Agent as HttpsAgent } from 'https';
import { SSL_CONFIG } from '@taql/ssl';

const makeAgentConfig = () => {
  const { rejectUnauthorized } = SSL_PARAMS;
  if (!rejectUnauthorized) {
    logger.warn(
      'fetch will not reject servers with bad certs by default. This is dangerous. Set SSL_REJECT_UNAUTHORIZED=true to rectify'
    );
  }
  return { rejectUnauthorized } as const;
};

//const cacheable = new CacheableLookup();

// Inspiration from https://gitlab.dev.tripadvisor.com/tripadvisor/web/-/blob/master/platform/component-server/service/isolate-service-caller.ts#L137-142
const agentDefaults = {
  keepAlive: true,
  maxSockets: 128,
  maxFreeSockets: 16,
};

export const agentConfig = makeAgentConfig();
export const httpsAgent: Agent = new HttpsAgent({
  ...SSL_CONFIG,
  ...agentConfig,
  ...agentDefaults,
});
//httpsAgent && cacheable.install(httpsAgent);

export const httpAgent: Agent = new Agent(agentDefaults);
//cacheable.install(httpAgent);
