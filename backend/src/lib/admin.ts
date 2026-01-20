import { Context, Next } from "hono";
import { db } from "../db/index";
import { users } from "../db/schema";
import { eq } from "drizzle-orm";
import { requireAuth, SessionData } from "./session";

export interface AdminContext {
  session: SessionData;
  adminUser: typeof users.$inferSelect;
}

/**
 * Middleware that enforces admin-only access
 * Usage: app.use("/admin/*", requireAdmin)
 */
export async function requireAdmin(c: Context, next: Next) {
  try {
    // First, ensure user is authenticated
    const session = await requireAuth(c);
    
    // Fetch user from database to check admin status
    const user = await db.query.users.findFirst({
      where: eq(users.id, session.userId),
    });
    
    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }
    
    // Check if user is active
    if (!user.isActive) {
      return c.json({ 
        error: "Forbidden",
        message: "Account is deactivated" 
      }, 403);
    }
    
    // Check if user is admin
    if (user.userType !== "admin") {
      return c.json({ 
        error: "Forbidden",
        message: "Admin access required" 
      }, 403);
    }
    
    // Attach admin info to context for use in handlers
    c.set("adminUser", user);
    c.set("session", session);
    
    await next();
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return c.json({ error: "Unauthorized" }, 401);
    }
    console.error("Admin middleware error:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
}