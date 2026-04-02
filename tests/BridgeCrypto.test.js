'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  generateKeyPair,
  deriveSharedKey,
  encrypt,
  decrypt,
  fingerprint,
} = require('../bridge/BridgeCrypto');

describe('BridgeCrypto', () => {
  it('generates a key pair with 32-byte public key', () => {
    const kp = generateKeyPair();
    assert.equal(kp.publicKey.length, 32);
    assert.equal(kp.secretKey.length, 32); // tweetnacl box secretKey is 32 bytes
  });

  it('derives the same shared key from both sides', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const keyA = deriveSharedKey(alice.secretKey, bob.publicKey);
    const keyB = deriveSharedKey(bob.secretKey, alice.publicKey);
    assert.deepStrictEqual(keyA, keyB);
    assert.equal(keyA.length, 32);
  });

  it('encrypts and decrypts roundtrip', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const sharedKey = deriveSharedKey(alice.secretKey, bob.publicKey);

    const plaintext = Buffer.from('Hello HashGrid!');
    const encrypted = encrypt(plaintext, sharedKey);
    assert.ok(encrypted.length > plaintext.length); // nonce + ciphertext + tag

    const decrypted = decrypt(encrypted, sharedKey);
    assert.deepStrictEqual(decrypted, plaintext);
  });

  it('fails to decrypt with wrong key', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const carol = generateKeyPair();
    const rightKey = deriveSharedKey(alice.secretKey, bob.publicKey);
    const wrongKey = deriveSharedKey(alice.secretKey, carol.publicKey);

    const encrypted = encrypt(Buffer.from('secret'), rightKey);
    assert.throws(() => decrypt(encrypted, wrongKey));
  });

  it('computes fingerprint as xx:xx:xx', () => {
    const kp = generateKeyPair();
    const fp = fingerprint(kp.publicKey);
    assert.match(fp, /^[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}$/);
  });
});
