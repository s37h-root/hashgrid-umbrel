'use strict';

const crypto = require('node:crypto');
const nacl = require('tweetnacl');
const { loadIdentityDER, saveIdentityDER } = require('./persistence');

const HKDF_SALT = Buffer.from('HashGrid-Remote-v1', 'utf8');

/**
 * Generate X25519 key pair using tweetnacl box.
 * Returns { publicKey: Uint8Array(32), secretKey: Uint8Array(64) }
 */
function generateKeyPair() {
  return nacl.box.keyPair();
}

/**
 * Derive 32-byte symmetric key from our secret key + their public key.
 * Uses X25519 shared secret → HKDF-SHA256.
 */
function deriveSharedKey(ourSecretKey, theirPublicKey) {
  // tweetnacl box.before computes X25519 shared secret (+ HSalsa20)
  // But we need raw X25519 for HKDF compatibility with macOS/Windows.
  // Use nacl.scalarMult for raw X25519.
  const ourPrivate = ourSecretKey.slice(0, 32); // first 32 bytes = scalar
  const sharedSecret = nacl.scalarMult(ourPrivate, theirPublicKey);

  // HKDF-SHA256 with salt "HashGrid-Remote-v1", empty info, 32-byte output
  const hkdfKey = crypto.hkdfSync('sha256', sharedSecret, HKDF_SALT, Buffer.alloc(0), 32);
  return Buffer.from(hkdfKey);
}

/**
 * Encrypt plaintext with ChaCha20-Poly1305.
 * Returns Buffer: nonce(12) || ciphertext(N) || tag(16)
 */
function encrypt(plaintextBuffer, symmetricKey) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('chacha20-poly1305', symmetricKey, nonce, { authTagLength: 16 });
  const ciphertext = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ciphertext, tag]);
}

/**
 * Decrypt ChaCha20-Poly1305 combined data.
 * Input: nonce(12) || ciphertext(N) || tag(16)
 */
function decrypt(combined, symmetricKey) {
  const nonce = combined.subarray(0, 12);
  const tag = combined.subarray(combined.length - 16);
  const ciphertext = combined.subarray(12, combined.length - 16);

  const decipher = crypto.createDecipheriv('chacha20-poly1305', symmetricKey, nonce, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Legacy EPHEMERAL public key fingerprint: first 3 bytes of SHA256 as hex
 * "xx:xx:xx". Old iOS apps check the wire `fingerprint` field against exactly
 * this format, so it MUST stay 3-group and MUST be computed over the ephemeral
 * X25519 key (never the identity key).
 */
function fingerprint(publicKey) {
  const hash = crypto.createHash('sha256').update(publicKey).digest();
  return [hash[0], hash[1], hash[2]]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(':');
}

// ---- Persistent Ed25519 identity key (TOFU pinning) ----

/**
 * Wide identity fingerprint for user verification: first 6 bytes (48-bit) of
 * SHA256 over the raw Ed25519 public key, colon-hex. This is what the web UI
 * shows and what the iOS app displays after pinning — NOT the 3-group
 * ephemeral value in the wire `fingerprint` field.
 */
function identityFingerprint(rawPublicKey) {
  const hash = crypto.createHash('sha256').update(rawPublicKey).digest();
  return Array.from(hash.subarray(0, 6))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(':');
}

// SPKI DER prefix for a raw 32-byte Ed25519 public key. Prepending it lets
// `crypto.createPublicKey` ingest the raw bytes (used only in tests here; the
// bridge itself never needs to reconstruct a peer identity key).
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Load the persistent Ed25519 identity, generating and saving it (owner-only
 * perms, pkcs8-DER) on first launch. Returns an object exposing the raw 32-byte
 * public key, a signing function, and the 6-group fingerprint.
 *
 * Signs with pure Ed25519 (RFC 8032) via Node's crypto, which is wire-compatible
 * with the mac/Windows bridges' CryptoKit `Curve25519.Signing`.
 */
function loadOrCreateIdentity() {
  let privateKey;
  const der = loadIdentityDER();
  if (der) {
    try {
      privateKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    } catch {
      privateKey = null;
    }
  }
  if (!privateKey) {
    const pair = crypto.generateKeyPairSync('ed25519');
    privateKey = pair.privateKey;
    saveIdentityDER(privateKey.export({ type: 'pkcs8', format: 'der' }));
    console.log('[BridgeCrypto] Generated new bridge identity key');
  }

  const publicKey = crypto.createPublicKey(privateKey);
  const rawPublicKey = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');

  return {
    // Raw 32-byte Ed25519 public key (base64 on the wire, same encoding as publicKey).
    publicKeyRaw: rawPublicKey,
    // Ed25519 signature (64 bytes) over the raw ephemeral X25519 public key bytes.
    sign(message) {
      return crypto.sign(null, message, privateKey);
    },
    // 48-bit user-facing fingerprint.
    fingerprint: identityFingerprint(rawPublicKey),
  };
}

module.exports = {
  generateKeyPair,
  deriveSharedKey,
  encrypt,
  decrypt,
  fingerprint,
  identityFingerprint,
  loadOrCreateIdentity,
  ED25519_SPKI_PREFIX,
};
