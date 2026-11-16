/** Firestore answers FAILED_PRECONDITION while an index deBug needs is missing or still building. */
export function isIndexError(message: string) {
  return /FAILED_PRECONDITION|requires an index|index is currently building/i.test(message);
}

/** A thrown Firestore error saying a composite index is missing (gRPC code 9), on the Firestore store only. */
export function isMissingIndex(e: unknown, store: string): boolean {
  if (store !== "firestore") return false;
  const err = e as { code?: unknown; message?: unknown } | undefined;
  const precondition = err?.code === 9 || err?.code === "failed-precondition";
  // FAILED_PRECONDITION has other causes too: only the index ones.
  return precondition && /index/i.test(String(err?.message ?? ""));
}
