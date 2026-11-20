// Decides whether the last completed scan is too old to trust.
// lastFinishedMs: epoch ms of the last clean scan, or null if it never ran.
export function isStale(lastFinishedMs, nowMs, maxAgeMs) {
  if (lastFinishedMs == null) return true;
  return nowMs - lastFinishedMs > maxAgeMs;
}