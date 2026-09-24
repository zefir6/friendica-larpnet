import { decodeRecoveryKey } from 'matrix-js-sdk/lib/crypto-api/recovery-key.js';

// Cross-device history recovery -- without this, each browser/profile is a
// separate Matrix "device" with its own independent E2EE identity, and a
// new device can never decrypt messages from before it existed. The fix is
// a client-side-generated recovery key (Element calls it a "Security
// Phrase"): shown to the user once, used to encrypt a backup of room keys.
// Any device that has it can unlock old history. The key is generated in
// the browser and never touches the server or this addon's PHP side --
// deliberately, per addon/larpnet_matrix/CLAUDE.md's "Why there's no
// device-verification UI": the operator must never be able to derive or
// know a user's recovery key.
//
// See CLAUDE.md's "Cross-device key recovery" section for the empirically-
// confirmed constraints this module works within (most importantly: never
// call `client.getCrypto().resetEncryption()` -- confirmed live against
// Synapse that resetting cross-signing on an already-set-up JWT-only
// account hits an unsatisfiable User-Interactive-Auth wall, and a failed
// reset can leave the account's key backup deleted with nothing to
// replace it).

// Per-client cache backing the crypto stack's `getSecretStorageKey`
// callback -- populated either by `cacheSecretStorageKey` (a brand new key
// just created by setUpRecovery()) or manually by restoreFromRecoveryKey()
// (an existing key the user typed in). Never persisted -- lives only as
// long as this page load, same lifetime as the rest of the crypto session
// (matrix.js never persists the access token either, for the same
// "one well-tested path, no hand-rolled shortcuts" reasoning).
export function createRecoveryKeyCache() {
  const cache = new Map();
  return {
    cryptoCallbacks: {
      getSecretStorageKey: async ({ keys }) => {
        for (const keyId of Object.keys(keys)) {
          if (cache.has(keyId)) {
            return [keyId, cache.get(keyId)];
          }
        }
        return null;
      },
      cacheSecretStorageKey: (keyId, _keyInfo, key) => {
        cache.set(keyId, key);
      },
    },
    set: (keyId, key) => cache.set(keyId, key),
  };
}

/**
 * What this device needs from the user, if anything:
 * - 'ready': this device can already decrypt everything key backup has.
 * - 'needs_setup': nobody has ever set up cross-signing/secret storage/key
 *   backup for this account -- show the one-time "here is your recovery
 *   key" flow.
 * - 'needs_restore': secret storage/key backup already exist remotely, but
 *   this device doesn't have the key yet -- prompt for an existing
 *   recovery key (skippable; the device still works for new messages).
 */
export async function getRecoveryStatus(client) {
  const crypto = client.getCrypto();
  if (await crypto.isSecretStorageReady()) {
    return 'ready';
  }
  return (await client.secretStorage.hasKey()) ? 'needs_restore' : 'needs_setup';
}

/**
 * First-ever setup for this account. Only call when getRecoveryStatus()
 * returned 'needs_setup' -- see this module's own docblock for why calling
 * it again once cross-signing already exists is unsafe.
 *
 * Returns the recovery key, encoded for display -- show it to the user
 * ONCE (they must save it themselves; we don't keep a copy anywhere) and
 * never log it.
 */
export async function setUpRecovery(client) {
  const crypto = client.getCrypto();

  // No UIA challenge for a *first-ever* device_signing/upload on a JWT-only
  // account -- confirmed live. (Overwriting existing cross-signing keys
  // does demand UIA, which this account has no way to satisfy -- but that
  // path is never taken here, since this function is only called when none
  // exist yet.)
  await crypto.bootstrapCrossSigning({
    authUploadDeviceSigningKeys: async (makeRequest) => {
      await makeRequest({});
    },
  });

  let encodedKey = null;
  await crypto.bootstrapSecretStorage({
    setupNewKeyBackup: true,
    createSecretStorageKey: async () => {
      const key = await crypto.createRecoveryKeyFromPassphrase();
      encodedKey = key.encodedPrivateKey;
      return key;
    },
  });
  return encodedKey;
}

/**
 * Unlocks this device's access to key backup using a recovery key the user
 * already has (from an earlier setUpRecovery() call on a different
 * device). Returns true on success, false on a malformed key or a restore
 * failure (wrong key, network error, ...) -- never throws, so callers can
 * show a plain "that didn't work" message without a try/catch.
 */
export async function restoreFromRecoveryKey(client, keyCache, recoveryKeyText) {
  const defaultKeyId = await client.secretStorage.getDefaultKeyId();
  if (!defaultKeyId) {
    return false;
  }
  let privateKey;
  try {
    privateKey = decodeRecoveryKey(recoveryKeyText.trim());
  } catch (e) {
    return false;
  }
  keyCache.set(defaultKeyId, privateKey);
  try {
    await client.getCrypto().restoreKeyBackup();
    return true;
  } catch (e) {
    return false;
  }
}
