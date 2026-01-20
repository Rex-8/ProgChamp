import { Hono } from "hono";
import { Google, generateState, generateCodeVerifier } from "arctic";
import { db } from "../db/index";
import { users } from "../db/schema";
import { eq } from "drizzle-orm";
import { createSession, destroySession, getSession } from "../lib/session";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";

const auth = new Hono();

// Initialize Google OAuth
const google = new Google(
  process.env.GOOGLE_CLIENT_ID!,
  process.env.GOOGLE_CLIENT_SECRET!,
  process.env.GOOGLE_REDIRECT_URI!
);

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

// GET /auth/google - Initiate OAuth flow
auth.get("/google", async (c) => {
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  
  const url = await google.createAuthorizationURL(state, codeVerifier, {
    scopes: ["email"], // Minimal scope - only email
  });
  
  // Store state and verifier in cookies for validation
  setCookie(c, "google_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 10, // 10 minutes
    path: "/",
  });
  
  setCookie(c, "google_code_verifier", codeVerifier, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 10,
    path: "/",
  });
  
  return c.redirect(url.toString());
});

// GET /auth/google/callback - Handle OAuth callback
auth.get("/google/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const storedState = getCookie(c, "google_oauth_state");
  const codeVerifier = getCookie(c, "google_code_verifier");
  
  // Validate state to prevent CSRF
  if (!code || !state || !storedState || state !== storedState || !codeVerifier) {
    return c.redirect(`${FRONTEND_URL}/auth/error?message=Invalid OAuth state`);
  }
  
  // Clean up state cookies
  deleteCookie(c, "google_oauth_state");
  deleteCookie(c, "google_code_verifier");
  
  try {
    // Exchange code for tokens
    const tokens = await google.validateAuthorizationCode(code, codeVerifier);
    
    // Fetch user info from Google
    const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    
    if (!response.ok) {
      throw new Error("Failed to fetch user info from Google");
    }
    
    const googleUser = await response.json() as {
      id: string;
      email: string;
    };
    
    // Check if user exists by Google ID
    const existingUser = await db.query.users.findFirst({
      where: eq(users.googleId, googleUser.id),
    });
    
    if (existingUser) {
      // Existing user - check if active
      if (!existingUser.isActive) {
        return c.redirect(`${FRONTEND_URL}/auth/error?message=Account deactivated`);
      }
      
      // Create session and redirect to home
      await createSession(c, existingUser.id, existingUser.email);
      return c.redirect(`${FRONTEND_URL}/home`);
    }
    
    // New user - check if email already exists (different Google account)
    const emailExists = await db.query.users.findFirst({
      where: eq(users.email, googleUser.email),
    });
    
    if (emailExists) {
      return c.redirect(`${FRONTEND_URL}/auth/error?message=Email already registered with different account`);
    }
    
    // Create new user with minimal info
    const userId = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await db.insert(users).values({
      id: userId,
      googleId: googleUser.id,
      email: googleUser.email,
      name: null, // User will set this in profile setup
      avatarUrl: null,
      userType: "normal",
      superlikesRemaining: 3,
      isActive: true,
    });
    
    // Create session
    await createSession(c, userId, googleUser.email);
    
    // Redirect to profile setup
    return c.redirect(`${FRONTEND_URL}/profile/setup`);
  } catch (error) {
    console.error("OAuth callback error:", error);
    return c.redirect(`${FRONTEND_URL}/auth/error?message=Authentication failed`);
  }
});

// GET /auth/session - Get current session
auth.get("/session", async (c) => {
  const session = await getSession(c);
  
  if (!session) {
    return c.json({ authenticated: false }, 401);
  }
  
  try {
    const user = await db.query.users.findFirst({
      where: eq(users.id, session.userId),
    });
    
    if (!user || !user.isActive) {
      destroySession(c);
      return c.json({ authenticated: false }, 401);
    }
    
    return c.json({
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        userType: user.userType,
        needsProfileSetup: !user.name, // Flag for frontend
      },
    });
  } catch (error) {
    console.error("Session fetch error:", error);
    return c.json({ authenticated: false }, 500);
  }
});

// POST /auth/logout - Destroy session
auth.post("/logout", async (c) => {
  destroySession(c);
  return c.json({ success: true, message: "Logged out successfully" });
});

export default auth;