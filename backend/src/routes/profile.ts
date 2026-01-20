import { Hono } from "hono";
import { db } from "../db/index";
import { users } from "../db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireAuth } from "../lib/session";

const profile = new Hono();

// Validation schemas
const profileSetupSchema = z.object({
  name: z.string().min(1).max(100),
  avatarUrl: z.string().url().optional(),
});

const profileUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  avatarUrl: z.string().url().optional(),
});

// GET /profile/public/:userId - Get public user details
profile.get("/public/:userId", async (c) => {
  const userId = c.req.param("userId");
  
  try {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        id: true,
        googleId: true,
        name: true,
        avatarUrl: true,
        email: true,
      },
    });
    
    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }
    
    if (!user.isActive) {
      return c.json({ error: "User account is deactivated" }, 403);
    }
    
    return c.json({
      googleId: user.googleId,
      name: user.name,
      avatarUrl: user.avatarUrl,
      email: user.email,
    });
  } catch (error) {
    console.error("Get public profile error:", error);
    return c.json({ error: "Failed to fetch profile" }, 500);
  }
});

// GET /profile/privileged/:userId - Get all user details (admin only - basic version)
profile.get("/privileged/:userId", async (c) => {
  try {
    // Get current user session
    const session = await requireAuth(c);
    
    // Get current user to check if admin
    const currentUser = await db.query.users.findFirst({
      where: eq(users.id, session.userId),
    });
    
    if (!currentUser) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    
    // Basic admin check (you'll enforce this properly later)
    if (currentUser.userType !== "admin") {
      return c.json({ 
        error: "Forbidden",
        message: "Admin access required" 
      }, 403);
    }
    
    // Fetch target user
    const userId = c.req.param("userId");
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });
    
    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }
    
    // Return all user fields
    return c.json({ user });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return c.json({ error: "Unauthorized" }, 401);
    }
    console.error("Get privileged profile error:", error);
    return c.json({ error: "Failed to fetch profile" }, 500);
  }
});

// PATCH /profile/setup - Complete profile setup (first time only)
profile.patch("/setup", async (c) => {
  try {
    const session = await requireAuth(c);
    
    const body = await c.req.json();
    const result = profileSetupSchema.safeParse(body);
    
    if (!result.success) {
      return c.json({ 
        error: "Invalid request data", 
        details: result.error.format() 
      }, 400);
    }
    
    const { name, avatarUrl } = result.data;
    
    // Get user
    const user = await db.query.users.findFirst({
      where: eq(users.id, session.userId),
    });
    
    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }
    
    // Check if profile already setup
    if (user.name) {
      return c.json({ 
        error: "Profile already setup",
        message: "Use /profile/update to modify your profile" 
      }, 400);
    }
    
    // Update profile
    const updated = await db
      .update(users)
      .set({
        name,
        avatarUrl: avatarUrl || null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, session.userId))
      .returning();
    
    return c.json({
      success: true,
      user: {
        id: updated[0].id,
        email: updated[0].email,
        name: updated[0].name,
        avatarUrl: updated[0].avatarUrl,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return c.json({ error: "Unauthorized" }, 401);
    }
    console.error("Profile setup error:", error);
    return c.json({ error: "Failed to setup profile" }, 500);
  }
});

// PATCH /profile/update - Update own profile
profile.patch("/update", async (c) => {
  try {
    const session = await requireAuth(c);
    
    const body = await c.req.json();
    const result = profileUpdateSchema.safeParse(body);
    
    if (!result.success) {
      return c.json({ 
        error: "Invalid request data", 
        details: result.error.format() 
      }, 400);
    }
    
    const updates = result.data;
    
    // Build update object (only include provided fields)
    const updateData: any = { updatedAt: new Date() };
    if (updates.name !== undefined) updateData.name = updates.name;
    if (updates.avatarUrl !== undefined) updateData.avatarUrl = updates.avatarUrl;
    
    // Update profile
    const updated = await db
      .update(users)
      .set(updateData)
      .where(eq(users.id, session.userId))
      .returning();
    
    if (!updated[0]) {
      return c.json({ error: "User not found" }, 404);
    }
    
    return c.json({
      success: true,
      user: {
        id: updated[0].id,
        email: updated[0].email,
        name: updated[0].name,
        avatarUrl: updated[0].avatarUrl,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return c.json({ error: "Unauthorized" }, 401);
    }
    console.error("Profile update error:", error);
    return c.json({ error: "Failed to update profile" }, 500);
  }
});

export default profile;