// Logs estructurados (Workers Logs los indexa como JSON). Nunca registrar PII en claro.

type Level = "debug" | "info" | "warn" | "error";

export function log(level: Level, msg: string, data: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, msg, ...data });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** 5219991234567 → 52******4567 */
export function maskPhone(phone: string): string {
  if (phone.length <= 6) return "***";
  return `${phone.slice(0, 2)}${"*".repeat(phone.length - 6)}${phone.slice(-4)}`;
}
