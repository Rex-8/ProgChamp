import { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-in-production";
const SESSION_COOKIE_NAME = "session";

export interface SessionData {
  userId: string;
  email: string;
}

export async function createSession(c: Context, userId: string, email: string) {
  const payload: SessionData = { userId, email };
  const token = await sign(payload, JWT_SECRET);
  
  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax",
    maxAge: 60 * 60 * 24 * 7, // 7 days
    path: "/",
  });
  
  return token;
}

export async function getSession(c: Context): Promise<SessionData | null> {
  const token = getCookie(c, SESSION_COOKIE_NAME);
  if (!token) return null;
  
  try {
    const payload = await verify(token, JWT_SECRET) as SessionData;
    return payload;
  } catch {
    return null;
  }
}

export function destroySession(c: Context) {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
}

export async function requireAuth(c: Context): Promise<SessionData> {
  const session = await getSession(c);
  if (!session) {
    throw new Error("Unauthorized");
  }
  return session;
}