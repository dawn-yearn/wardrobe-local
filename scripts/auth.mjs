function setting(env, name, fallback = "") {
  return env?.[name] || process.env[name] || fallback;
}

export class AuthError extends Error {
  constructor(message = "Authentication required", status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

function bearerToken(req) {
  const value = req.headers?.authorization || req.headers?.Authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1] || null;
}

export async function authenticateRequest(req, { env = {}, verify = null } = {}) {
  const token = bearerToken(req);
  if (!token) throw new AuthError();
  if (verify) return verify(token);

  const authBase = setting(env, "SUPABASE_AUTH_URL", setting(env, "SUPABASE_URL"));
  const apiKey = setting(env, "SUPABASE_ANON_KEY", setting(env, "SUPABASE_SERVICE_ROLE_KEY"));
  if (!authBase) throw new AuthError("Auth server is not configured", 503);

  let response;
  try {
    response = await fetch(`${authBase.replace(/\/$/, "")}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(apiKey ? { apikey: apiKey } : {}),
      },
    });
  } catch (error) {
    throw Object.assign(new Error(`Auth server unavailable: ${error.message}`), { status: 503 });
  }
  if (!response.ok) throw new AuthError("Invalid or expired session", response.status === 401 ? 401 : 503);
  const user = await response.json().catch(() => null);
  if (!user?.id) throw new AuthError("Auth server returned no user", 503);
  return { id: user.id, phone: user.phone || null, email: user.email || null, raw: user };
}

export function maskPhone(phone) {
  if (typeof phone !== "string" || !phone.trim()) return null;
  const value = phone.trim();
  if (value.length <= 4) return "****";
  return `${value.slice(0, 3)}****${value.slice(-2)}`;
}

export function jsonError(res, error) {
  const status = Number(error?.status) || 500;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({
    error: status === 500 ? "Internal server error" : error.message,
    ...(process.env.NODE_ENV === "development" && status === 500 ? { detail: error.message } : {}),
  }));
}
