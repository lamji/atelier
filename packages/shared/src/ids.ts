const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Compact, sortable, dependency-free id: time prefix + random suffix. */
export function newId(prefix = ""): string {
  let time = Date.now();
  let timePart = "";
  for (let i = 0; i < 10; i++) {
    timePart = ALPHABET[time % 32] + timePart;
    time = Math.floor(time / 32);
  }
  let rand = "";
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  for (const b of bytes) rand += ALPHABET[b % 32];
  return prefix ? `${prefix}_${timePart}${rand}` : `${timePart}${rand}`;
}
