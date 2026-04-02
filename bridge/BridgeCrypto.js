'use strict';

const crypto = require('node:crypto');
const nacl = require('tweetnacl');

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
 * Public key fingerprint: first 3 bytes of SHA256 as hex "xx:xx:xx"
 */
function fingerprint(publicKey) {
  const hash = crypto.createHash('sha256').update(publicKey).digest();
  return [hash[0], hash[1], hash[2]]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(':');
}

module.exports = { generateKeyPair, deriveSharedKey, encrypt, decrypt, fingerprint };
