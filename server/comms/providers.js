// One interface over the two ways a class's messages leave Skyll (D2, D13):
//   meta — the real WhatsApp Cloud API with the class's own business token;
//   test — a stand-in for automated tests and an unconnected demo school. It
//          never contacts anyone. Numbers ending 0000000 fail as "not on
//          WhatsApp", numbers ending 0000001 fail as temporarily busy.
import { randomUUID } from 'node:crypto';
import { ProviderError } from './errors.js';
import * as meta from './meta.js';
import { decryptSecret } from './secrets.js';

function testProvider() {
  return {
    kind: 'test',
    async send({ to }) {
      if (String(to).endsWith('0000000')) throw new ProviderError({ kind: 'recipient', code: '131026', reason: 'This number is not on WhatsApp or could not receive the message' });
      if (String(to).endsWith('0000001')) throw new ProviderError({ kind: 'temporary', code: '131000', reason: 'WhatsApp is busy; Skyll will try again shortly' });
      // The demo has no webhooks, so the test provider reports delivery at once.
      return { id: `wamid.test.${randomUUID()}`, simulatedStatus: 'delivered' };
    },
    async uploadMedia() { return `media.test.${randomUUID()}`; },
    async submitTemplate() { return { id: `tpl.test.${randomUUID()}`, status: 'APPROVED', category: 'UTILITY' }; },
    async listTemplates() { return null; },
    async phoneInfo() { return { quality_rating: 'GREEN', status: 'CONNECTED' }; },
  };
}

function metaProvider(connection, options) {
  const token = decryptSecret(connection.token_enc);
  return {
    kind: 'meta',
    async send({ to, message }) {
      const result = await meta.sendMessage(token, connection.phone_number_id, { recipient_type: 'individual', to, ...message }, options);
      const id = result.messages?.[0]?.id;
      if (!id) throw new ProviderError({ kind: 'request', reason: 'WhatsApp did not confirm the message' });
      return { id };
    },
    uploadMedia: (file) => meta.uploadMedia(token, connection.phone_number_id, file, options),
    submitTemplate: (payload) => meta.submitTemplate(token, connection.waba_id, payload, options),
    listTemplates: () => meta.listTemplates(token, connection.waba_id, options),
    uploadTemplateSample: (file) => meta.uploadTemplateSample(token, file, options),
    phoneInfo: () => meta.phoneNumberInfo(token, connection.phone_number_id, options),
  };
}

/** The provider for a connection row. `options.fetchImpl` lets tests stub Meta. */
export function providerFor(connection, options = {}) {
  if (!connection) throw new Error('No WhatsApp connection');
  if (connection.provider === 'test') return testProvider();
  if (!connection.token_enc) throw new ProviderError({ kind: 'class', code: '190', reason: 'The WhatsApp connection has expired; reconnect WhatsApp' });
  return metaProvider(connection, options);
}
