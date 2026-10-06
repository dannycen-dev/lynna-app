// Hash de contraseñas con PBKDF2-SHA256 (WebCrypto nativo: no consume CPU de JS en el Worker).
// Formato: pbkdf2-sha256$<iteraciones>$<sal base64>$<hash base64>. Las iteraciones viajan en el
// hash para poder subirlas después sin invalidar contraseñas existentes (se re-hashea al entrar).
//
// scripts/create-user.mjs genera el mismo formato desde Node: si cambias algo aquí, cámbialo allá.

export const PBKDF2_ITERATIONS = 100_000;
const KEY_BITS = 256;
const encoder = new TextEncoder();

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, KEY_BITS);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${toB64(salt)}$${toB64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<{ ok: boolean; needsRehash: boolean }> {
  const [scheme, iter, saltB64, hashB64] = stored.split("$");
  const iterations = Number(iter);
  if (scheme !== "pbkdf2-sha256" || !Number.isInteger(iterations) || !saltB64 || !hashB64) {
    return { ok: false, needsRehash: false };
  }
  const expected = fromB64(hashB64);
  const actual = await derive(password, fromB64(saltB64), iterations);
  const ok = actual.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(actual, expected);
  return { ok, needsRehash: ok && iterations < PBKDF2_ITERATIONS };
}

/** Hash ficticio para igualar el tiempo de respuesta cuando el correo no existe. */
export const DUMMY_HASH = "pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export const MIN_PASSWORD_LENGTH = 10;
