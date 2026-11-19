/**
 * An app's display name, set in Settings: "Megatron Native" for the app whose id is
 * "megatron-native". The id stays what the SDK sends and what URLs and keys use; the name is only
 * what people read. Empty means "show the id".
 */
export const MAX_APP_NAME = 60;

/** Check a display name from Settings. Returns the cleaned name ("" to go back to the id), or what's wrong. */
export function validAppName(x: unknown): { name: string } | string {
  if (typeof x !== "string") return "The app name must be text";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(x)) return "The app name can't have line breaks or control characters";
  const name = x.trim().replace(/\s+/g, " ");
  if (name.length > MAX_APP_NAME) return `Use an app name of up to ${MAX_APP_NAME} characters`;
  return { name };
}

/** What people see an app as: its display name, else its id. */
export const appLabel = (id: string, name?: string | null): string => name?.trim() || id;
