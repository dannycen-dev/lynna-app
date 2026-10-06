const encoder = new TextEncoder();

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Valida `X-Hub-Signature-256: sha256=<hex>` (HMAC-SHA256 del cuerpo crudo con el app secret).
 * `crypto.subtle.verify` compara en tiempo constante.
 */
export async function verifyMetaSignature(
  rawBody: string,
  header: string | null | undefined,
  appSecret: string,
): Promise<boolean> {
  if (!header || !appSecret || !header.startsWith("sha256=")) return false;
  const signature = hexToBytes(header.slice("sha256=".length));
  if (!signature) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(rawBody));
}

/** Solo para tests y herramientas locales: firma un cuerpo como lo haría Meta. */
export async function signMetaBody(rawBody: string, appSecret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody)));
  return `sha256=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
