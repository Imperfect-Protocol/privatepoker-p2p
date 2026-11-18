/**
 * Timer handles owned by the neural overlay are auxiliary, so on Node they are
 * unreferenced: an idle overlay must never be the only reason a process (or a
 * test runner) stays alive. Browsers return numeric handles, where `unref` does
 * not exist and the optional call is a no-op.
 */
export function setDetachedTimer(runtime, callback, milliseconds) {
  const handle = runtime.setTimer(callback, milliseconds);
  handle?.unref?.();
  return handle;
}

export function clearDetachedTimer(runtime, handle) {
  if (handle === null || handle === undefined) return;
  runtime.clearTimer(handle);
}
