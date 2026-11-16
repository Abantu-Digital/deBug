/** Firestore answers FAILED_PRECONDITION while an index deBug needs is missing or still building. */
export function isIndexError(message: string) {
  return /FAILED_PRECONDITION|requires an index|index is currently building/i.test(message);
}

/** A thrown Firestore error saying a composite index is missing (gRPC code 9), on the Firestore store only. */
export function isMissingIndex(e: unknown, store: string): boolean {
  const err = e as { code?: unknown; message?: unknown } | undefined;
  return store === "firestore" && (err?.code === 9 || err?.code === "failed-precondition" || isIndexError(String(err?.message ?? ""))) && /index/i.test(String(err?.message ?? ""));
}
