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
 *
 * IMPORTANT, confirmed empirically (do not "simplify" this back to
 * isSecretStorageReady() alone): `crypto.isSecretStorageReady()` is an
 * ACCOUNT-level check -- once ANY device has ever bootstrapped secret
 * storage, it returns true on *every* device of that account forever
 * after, including ones that have never unlocked it themselves. Using it
 * here meant a brand-new device was silently classified 'ready' and never
 * prompted, while still being completely unable to decrypt anything (and,
 * just as importantly, never enabling key backup *uploads* for its own
 * outgoing messages either -- see setUpRecovery()'s doc). The correct
 * per-device signal is `getActiveSessionBackupVersion()`: null until this
 * specific device has actually loaded/enabled the backup decryption key.
 */
export async function getRecoveryStatus(client) {
  const crypto = client.getCrypto();
  if ((await crypto.getActiveSessionBackupVersion()) !== null) {
    return 'ready';
  }
  return (await client.secretStorage.hasKey()) ? 'needs_restore' : 'needs_setup';
}

/**
 * First-ever setup for this account. Only call when getRecoveryStatus()
 * returned 'needs_setup' -- see this module's own docblock for why calling
 * it again once cross-signing already exists is unsafe.
 *
 * `setupNewKeyBackup: true` below makes bootstrapSecretStorage() call
 * resetKeyBackup() internally, which -- unlike restoreFromRecoveryKey()'s
 * path -- generates and caches the backup decryption key directly rather
 * than reading it back from secret storage, and starts this device's own
 * backup-upload loop as a side effect. So *this* device (the one that
 * runs setup) needs no extra step to get key backup active for itself;
 * only a *different* device restoring afterwards needs
 * loadSessionBackupPrivateKeyFromSecretStorage() first.
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
 *
 * Three steps, in order -- each one confirmed empirically necessary by
 * omitting it and watching the next thing fail or silently not work:
 *
 * 1. `loadSessionBackupPrivateKeyFromSecretStorage()` -- reads the actual
 *    backup decryption key (a *different* secret, `m.megolm_backup.v1`)
 *    out of secret storage using the recovery key, and caches it in this
 *    device's own local crypto store. Skipping this makes step 2 throw
 *    "No decryption key found in crypto store" even with the right
 *    recovery key already cached via getSecretStorageKey.
 * 2. `restoreKeyBackup()` -- now that the decryption key is cached,
 *    downloads and decrypts whatever *other* devices have already backed
 *    up. This is the "read old history" half.
 * 3. `bootstrapCrossSigning()` called *again* -- yes, again, on a device
 *    that didn't create the keys. When cross-signing keys already exist
 *    in (now-unlocked) secret storage, this call takes a different,
 *    UIA-free internal path that just imports and caches them locally
 *    (confirmed live via the SDK's own log line: "Cross-signing private
 *    keys not found locally, but they are available in secret storage,
 *    reading storage and caching locally") -- it does NOT attempt to
 *    create or overwrite anything, so it's safe to call unconditionally
 *    here. Skipping this step leaves `checkKeyBackupAndEnable()` seeing
 *    the backup as *untrusted* (confirmed live:
 *    `[RustBackupManager] Key backup present on server but not trusted:
 *    not enabling key backup`) -- meaning step 1-2 alone let this device
 *    read old messages, but its own *new* outgoing messages still never
 *    get uploaded to backup, so no future device (including this
 *    account's own) could ever recover them either. This step is the
 *    "make this device's own future messages recoverable too" half --
 *    just as important as being able to read history, not an optional
 *    extra.
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
    const crypto = client.getCrypto();
    await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
    await crypto.restoreKeyBackup();
    await crypto.bootstrapCrossSigning({
      authUploadDeviceSigningKeys: async (makeRequest) => {
        await makeRequest({});
      },
    });
    return true;
  } catch (e) {
    return false;
  }
}
