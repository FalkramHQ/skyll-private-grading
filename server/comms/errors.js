// Meta Cloud API errors, sorted by what they mean for a message (D12):
//   temporary — retry later (rate limits, Meta busy, network);
//   recipient — this parent can't get it (not on WhatsApp, 24 h window);
//   template  — one template is paused or disabled by Meta;
//   class     — nothing will send for this class until someone fixes it;
//   request   — Skyll sent something Meta rejects (a bug; not retried).
// Every kind carries a plain reason shown to staff.

export class ProviderError extends Error {
  constructor({ kind, code = null, reason, detail = null, status = null }) {
    super(reason);
    this.name = 'ProviderError';
    this.kind = kind;
    this.code = code === null ? null : String(code);
    this.reason = reason;
    this.detail = detail;
    this.status = status;
  }
}

const TEMPORARY = new Set(['1', '2', '4', '17', '341', '80007', '130429', '131000', '131016', '131056', '131057', '133004']);

const RECIPIENT = {
  131026: 'This number is not on WhatsApp or could not receive the message',
  131021: 'The recipient is the class’s own number',
  131047: 'More than 24 hours since the parent last messaged, so free text is not allowed',
  131049: 'WhatsApp did not deliver this message to keep the parent’s inbox healthy; try again later',
  131050: 'The parent has stopped marketing messages from this number',
  130472: 'The parent’s number is part of a WhatsApp experiment and could not receive it',
  131052: 'The attachment could not be downloaded',
  131053: 'The attachment could not be uploaded',
};

const TEMPLATE = {
  132015: 'Meta paused this message template after low ratings',
  132016: 'Meta disabled this message template',
  132001: 'This message template is not approved for the class’s number yet',
};

const CLASS = {
  0: 'Meta could not authenticate the class’s WhatsApp connection; reconnect WhatsApp',
  3: 'Skyll is missing permission for the class’s WhatsApp account; reconnect WhatsApp',
  10: 'Skyll is missing permission for the class’s WhatsApp account; reconnect WhatsApp',
  190: 'The WhatsApp connection has expired; reconnect WhatsApp',
  200: 'Skyll is missing permission for the class’s WhatsApp account; reconnect WhatsApp',
  368: 'Meta has temporarily restricted the class’s WhatsApp account for policy reasons',
  131031: 'Meta has locked the class’s WhatsApp account',
  131037: 'The class’s WhatsApp display name is not approved yet',
  131042: 'Meta could not charge the class’s payment method; update it in Meta Business Suite',
  131045: 'The class’s number is not registered with WhatsApp; reconnect WhatsApp',
  131048: 'Meta is limiting this number because too many messages were blocked or reported',
  133010: 'The class’s number is not registered with WhatsApp; reconnect WhatsApp',
  133005: 'The number’s two-step verification PIN does not match; reconnect WhatsApp',
  133006: 'The number needs verifying again; reconnect WhatsApp',
};

/** Classifies a Meta error object (`{ code, error_subcode, message }`) and HTTP status. */
export function classifyMetaError(error = {}, status = null) {
  const code = error.code === undefined || error.code === null ? null : String(error.code);
  const detail = String(error.error_user_msg || error.message || error.title || '').slice(0, 300) || null;
  if (code && Object.hasOwn(CLASS, code) && !(code === '0' && status !== 401)) {
    return new ProviderError({ kind: 'class', code, reason: CLASS[code], detail, status });
  }
  if (status === 401) return new ProviderError({ kind: 'class', code: code || '190', reason: CLASS[190], detail, status });
  if (code && Object.hasOwn(TEMPLATE, code)) return new ProviderError({ kind: 'template', code, reason: TEMPLATE[code], detail, status });
  if (code && Object.hasOwn(RECIPIENT, code)) return new ProviderError({ kind: 'recipient', code, reason: RECIPIENT[code], detail, status });
  if ((code && TEMPORARY.has(code)) || (status && status >= 500) || status === 429) {
    return new ProviderError({ kind: 'temporary', code, reason: 'WhatsApp is busy; Skyll will try again shortly', detail, status });
  }
  return new ProviderError({ kind: 'request', code, reason: 'WhatsApp rejected this message', detail, status });
}

export function networkError(error) {
  const timedOut = error?.name === 'AbortError' || error?.name === 'TimeoutError';
  return new ProviderError({
    kind: 'temporary',
    code: timedOut ? 'timeout' : 'network',
    reason: timedOut ? 'WhatsApp did not answer in time; Skyll will try again shortly' : 'Could not reach WhatsApp; Skyll will try again shortly',
    detail: String(error?.message || error).slice(0, 300),
  });
}
