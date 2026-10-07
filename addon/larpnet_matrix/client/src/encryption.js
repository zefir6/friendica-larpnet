import { getRecoveryStatus, setUpRecovery, resetRecovery, restoreFromRecoveryKey } from './recovery.js';

// Encryption modes -- see addon/larpnet_matrix/CLAUDE.md "Encryption modes".
// 'standard' (default): the server holds a per-user recovery passphrase and
// hands it to this client, which silently sets up / unlocks secret storage
// with it -- the user never types anything. 'private': only the user knows
// their key, and the old manual prompts apply.
//
// Same decision tree as the native clients' ensureEncryption()
// (larpnet-android MatrixRepository.kt, larpnet-ios MatrixClientStore.swift)
// -- keep the three in step.

// POST /larpnet_matrix/encryption (larpnet_matrix_encryption_endpoint()).
// Relative URL on purpose: resolves next to larpnet_matrix/app.js whether
// this page is the bare iframe document or the ?full=1 page.
export async function encryptionApi(config, action) {
  const res = await fetch('larpnet_matrix/encryption', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRF-Token': config.csrfToken || '',
    },
    body: 'action=' + encodeURIComponent(action),
  });
  if (!res.ok) {
    throw new Error('encryption endpoint ' + action + ' failed: ' + res.status);
  }
  return res.json();
}

// Both switches rotate secret storage via resetRecovery(), which is only
// clean from a device that already holds the cross-signing private keys.
export class DeviceLockedError extends Error {}

async function requireUnlocked(client) {
  if ((await getRecoveryStatus(client)) !== 'ready') {
    throw new DeviceLockedError('chat history is not unlocked on this device');
  }
}

const isStandard = (enc) => enc && enc.mode === 'standard' && !!enc.passphrase;

/**
 * Run once per session after the initial sync. Returns the prompt App.jsx
 * should show, or null:
 * - 'needs_setup' / 'needs_restore': private mode (or escrow unavailable)
 *   -- the old user-held-key flow, unchanged.
 * - 'needs_restore_legacy': standard mode, but the account still has a
 *   user-chosen key from before this existed and this device was never
 *   unlocked with it. Resetting from here would create secret storage
 *   without the cross-signing private keys (bootstrapSecretStorage() only
 *   exports keys it holds locally, and re-creating cross-signing needs a
 *   UIA stage JWT-only accounts don't have -- see recovery.js's header),
 *   so instead the user unlocks once with the old key and the next run of
 *   this function migrates from an unlocked device, which is clean.
 *
 * Never resets when the server says 'active': a failed restore there falls
 * back to the manual prompt, so a transient error can never wipe history.
 */
export async function ensureEncryption(client, keyCache, config, enc) {
  const status = await getRecoveryStatus(client);
  if (!isStandard(enc)) {
    return status === 'ready' ? null : status;
  }
  const passphrase = enc.passphrase;

  if (enc.state === 'pending') {
    if (status === 'needs_setup') {
      await setUpRecovery(client, passphrase);
      await encryptionApi(config, 'confirm');
      return null;
    }
    if (status === 'ready') {
      // Force-migrates a legacy user-chosen key (or completes a switch back
      // from private mode). This device's own room keys are re-uploaded to
      // the new backup, so history it can read survives.
      await resetRecovery(client, passphrase);
      await encryptionApi(config, 'confirm');
      return null;
    }
    // needs_restore: maybe another device already applied this passphrase
    // and just didn't get to confirm it.
    if (await restoreFromRecoveryKey(client, keyCache, passphrase)) {
      await encryptionApi(config, 'confirm');
      return null;
    }
    return 'needs_restore_legacy';
  }

  // active
  if (status === 'needs_restore') {
    return (await restoreFromRecoveryKey(client, keyCache, passphrase)) ? null : 'needs_restore';
  }
  if (status === 'needs_setup') {
    // Secret storage vanished server-side; recreate it under the same passphrase.
    await setUpRecovery(client, passphrase);
    return null;
  }
  return null;
}

/**
 * Standard -> private. `passphrase` undefined = random key. Our copy is
 * dropped server-side only AFTER the rotation succeeded -- the other order
 * could leave the account behind a passphrase nobody has. Returns the
 * encoded key to show the user once.
 */
export async function switchToPrivate(client, config, passphrase) {
  await requireUnlocked(client);
  const key = await resetRecovery(client, passphrase);
  await encryptionApi(config, 'set_private');
  return key;
}

/**
 * Private -> standard. Needs this device unlocked (getRecoveryStatus()
 * 'ready'), same reason as 'needs_restore_legacy' above. If the reset fails
 * after prepare_standard, the server stays 'pending' and the next
 * ensureEncryption() on any unlocked device finishes the switch.
 */
export async function switchToStandard(client, config) {
  await requireUnlocked(client);
  const enc = await encryptionApi(config, 'prepare_standard');
  if (!enc.passphrase) {
    // Never fall through to resetRecovery(client, undefined) -- that would
    // silently rotate to a random key the user never sees.
    throw new Error('server returned no passphrase');
  }
  await resetRecovery(client, enc.passphrase);
  return encryptionApi(config, 'confirm');
}
