/** Firestore answers FAILED_PRECONDITION while an index deBug needs is missing or still building. */
export function isIndexError(message: string) {
  return /FAILED_PRECONDITION|requires an index|index is currently building/i.test(message);
}
