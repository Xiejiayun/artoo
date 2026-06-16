/**
 * Minimal cookie read/write for #34 auth (no @fastify/cookie dependency). The
 * server controls the security attributes precisely: HttpOnly, Secure (in prod),
 * SameSite=Lax, Path=/.
 */

/** Parse a `Cookie` request header into a name->value map. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === undefined) {
    return out;
  }
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const name = part.slice(0, eq).trim();
    if (name.length === 0) {
      continue;
    }
    const raw = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

export interface CookieAttributes {
  secure: boolean;
  /** Lifetime in ms; omit for a session cookie. 0 expires immediately. */
  maxAgeMs?: number;
  sameSite?: "Lax" | "Strict" | "None";
  httpOnly?: boolean;
  path?: string;
}

/** Serialize a `Set-Cookie` value with HttpOnly + SameSite=Lax by default. */
export function serializeCookie(name: string, value: string, attrs: CookieAttributes): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${attrs.path ?? "/"}`);
  if (attrs.httpOnly !== false) {
    parts.push("HttpOnly");
  }
  if (attrs.secure) {
    parts.push("Secure");
  }
  parts.push(`SameSite=${attrs.sameSite ?? "Lax"}`);
  if (attrs.maxAgeMs !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(attrs.maxAgeMs / 1000))}`);
  }
  return parts.join("; ");
}

/** A `Set-Cookie` value that clears the named cookie. */
export function clearCookie(name: string, attrs: Pick<CookieAttributes, "secure" | "path">): string {
  return serializeCookie(name, "", { ...attrs, maxAgeMs: 0 });
}
