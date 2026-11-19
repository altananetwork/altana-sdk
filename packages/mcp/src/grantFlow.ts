/**
 * The order a session grant runs in: the session's key is stored before
 * anything is paid for.
 *
 * A grant costs a registration fee and writes the key on chain. Stored
 * afterwards, a keychain write that fails leaves a paid, authorized key that
 * nobody holds. Stored first, the worst case is a stored key for a grant that
 * did not happen, and that key is removed again.
 *
 * No I/O of its own, so it is unit tested with fakes (grantFlow.test.ts).
 */
export async function storeKeyThenGrant<T>(steps: {
  /** Puts the session's private key where `session_execute` will find it. */
  storeKey: () => Promise<void>;
  /** Sends the grant. Throws when the account did not authorize the key. */
  grant: () => Promise<T>;
  /** Removes the stored key again, for a grant that did not happen. */
  removeKey: () => Promise<void>;
}): Promise<T> {
  await steps.storeKey();
  try {
    return await steps.grant();
  } catch (err) {
    // The grant's own error is the one worth reading; a failed clean-up must not replace it.
    await steps.removeKey().catch(() => undefined);
    throw err;
  }
}
