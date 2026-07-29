/**
 * Readable text for anything a catch block receives.
 *
 * The bridge rejects with a plain `{ code, message }` object rather than
 * an Error, so `String(err)` on it renders "[object Object]" — which is
 * what the Git panel was showing instead of the reason git failed.
 */
export function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const { message, code } = error as { message?: unknown; code?: unknown };
    if (typeof message === "string" && message) return message;
    if (typeof code === "string" && code) return code;
    try {
      return JSON.stringify(error);
    } catch {
      return "Unknown error";
    }
  }
  return String(error);
}
