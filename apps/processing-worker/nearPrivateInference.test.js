// @vitest-environment node
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';
import { nearPrivateEnabledFor, replayRtmr3, verifyResponseSignature } from './nearPrivateInference.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const model = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
const requestBytes = Buffer.from('{"model":"m","messages":[]}');
const responseBytes = Buffer.from('{"id":"chat-1","choices":[]}');

function ecdsaSigner(wallet) {
  return { algo: 'ecdsa', address: Buffer.from(wallet.address.slice(2), 'hex'), signing_address: wallet.address.toLowerCase() };
}

async function signedBy(wallet, text, kind = 'provider_tee') {
  return { text, signature: await wallet.signMessage(Buffer.from(text, 'utf8')), signing_address: wallet.address, signing_algo: 'ecdsa', signature_kind: kind };
}

describe('verifyResponseSignature', () => {
  const tee = Wallet.createRandom();
  const gateway = Wallet.createRandom();
  const attestation = { gateway: ecdsaSigner(gateway), models: [ecdsaSigner(tee)] };
  const text = `${model}:${sha(requestBytes)}:${sha(responseBytes)}`;

  it('accepts a TEE signature over the exact request and response bytes', async () => {
    const checked = verifyResponseSignature({ signature: await signedBy(tee, text), requestBytes, responseBytes, model, attestation });
    expect(checked.kind).toBe('provider_tee');
    expect(checked.responseSha256).toBe(sha(responseBytes));
  });

  it('accepts a gateway signature, which omits the model id', async () => {
    const gatewayText = `${sha(requestBytes)}:${sha(responseBytes)}`;
    const checked = verifyResponseSignature({ signature: await signedBy(gateway, gatewayText, 'gateway'), requestBytes, responseBytes, model, attestation });
    expect(checked.kind).toBe('gateway');
  });

  it('rejects a response whose bytes differ from what was signed', async () => {
    const signature = await signedBy(tee, text);
    expect(() => verifyResponseSignature({ signature, requestBytes, responseBytes: Buffer.from('{"tampered":true}'), model, attestation }))
      .toThrow(/exact request and response bytes/);
  });

  it('rejects a key that is not in the verified attestation', async () => {
    const signature = await signedBy(Wallet.createRandom(), text);
    expect(() => verifyResponseSignature({ signature, requestBytes, responseBytes, model, attestation }))
      .toThrow(/matches 0 verified/);
  });

  it('rejects a signature that claims an attested address it was not made by', async () => {
    const forged = { ...(await signedBy(Wallet.createRandom(), text)), signing_address: tee.address };
    expect(() => verifyResponseSignature({ signature: forged, requestBytes, responseBytes, model, attestation }))
      .toThrow(/does not match the signing key/);
  });

  it('verifies ed25519 signatures with the raw public key', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
    const signature = { text, signature: sign(null, Buffer.from(text), privateKey).toString('hex'), signing_address: raw.toString('hex'), signing_algo: 'ed25519', signature_kind: 'provider_tee' };
    const edAttestation = { gateway: attestation.gateway, models: [{ algo: 'ed25519', address: raw, signing_address: `0x${raw.toString('hex')}` }] };
    expect(verifyResponseSignature({ signature, requestBytes, responseBytes, model, attestation: edAttestation }).kind).toBe('provider_tee');
  });
});

describe('replayRtmr3', () => {
  it('folds only imr 3 events, starting from 48 zero bytes', () => {
    const event = { imr: 3, event_type: 134217729, event: 'compose-hash', event_payload: 'ab' };
    const type = Buffer.alloc(4);
    type.writeUInt32LE(event.event_type);
    const digest = createHash('sha384').update(Buffer.concat([type, Buffer.from(':compose-hash:'), Buffer.from('ab', 'hex')])).digest();
    const expected = createHash('sha384').update(Buffer.concat([Buffer.alloc(48), digest])).digest();
    expect(replayRtmr3([{ imr: 1, event_type: 1, event: 'x', event_payload: '' }, event])).toEqual(expected);
  });
});

describe('nearPrivateEnabledFor', () => {
  const saved = { key: process.env.NEAR_AI_API_KEY, schools: process.env.NEAR_AI_SCHOOLS };
  afterEach(() => {
    process.env.NEAR_AI_API_KEY = saved.key ?? '';
    process.env.NEAR_AI_SCHOOLS = saved.schools ?? '';
  });

  it('is off without a key, even for a listed school', () => {
    process.env.NEAR_AI_API_KEY = '';
    process.env.NEAR_AI_SCHOOLS = 'Demo School';
    expect(nearPrivateEnabledFor('Demo School')).toBe(false);
  });

  it('matches listed schools case-insensitively, or every school with *', () => {
    process.env.NEAR_AI_API_KEY = 'sk-test';
    process.env.NEAR_AI_SCHOOLS = 'Demo School, Other';
    expect(nearPrivateEnabledFor('demo school')).toBe(true);
    expect(nearPrivateEnabledFor('Third')).toBe(false);
    expect(nearPrivateEnabledFor('')).toBe(false);
    process.env.NEAR_AI_SCHOOLS = '*';
    expect(nearPrivateEnabledFor('Third')).toBe(true);
  });
});
