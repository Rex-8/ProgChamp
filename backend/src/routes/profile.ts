import { Hono } from "hono";
import { db } from "../db/index";
import { users } from "../db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireAuth } from "../lib/session";
import { requireAdmin } from "../lib/admin";

const profile = new Hono();

// Validation schemas
const profileSetupSchema = z.object({
  name: z.string()
    .min(1, "Name is required")
    .max(100, "Name too long")
    .regex(/^[a-zA-Z0-9\s_-]+$/, "Name contains invalid characters"),
  avatarUrl: z.string()
    .url("Invalid avatar URL")
    .optional()
    .or(z.literal("")),
});

const profileUpdateSchema = z.object({
  name: z.string()
    .min(1, "Name is required")
    .max(100, "Name too long")
    .regex(/^[a-zA-Z0-9\s_-]+$/, "Name contains invalid characters")
    .optional(),
  avatarUrl: z.string()
    .url("Invalid avatar URL")
    .optional()
    .or(z.literal("")),
});

const userIdParamSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
});

// GET /profile/public/:userId - Get public user details
profile.get("/public/:userId", async (c) => {
  const userId = c.req.param("userId");
  
  // Validate user ID
  const paramValidation = userIdParamSchema.safeParse({ userId });
  if (!paramValidation.success) {
    return c.json({ 
      error: "Invalid user ID",
      details: paramValidation.error.format()
    }, 400);
  }
  
  try {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        id: true,
        name: true,
        avatarUrl: true,
        email: true,
        isActive: true,
      },
    });
    
    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }
    
    if (!user.isActive) {
      return c.json({ error: "User account is deactivated" }, 403);
    }
    
    return c.json({
      id: user.id,
      name: user.name,
      avatarUrl: user.avatarUrl,
      email: user.email,
    });
  } catch (error) {
    console.error("Get public profile error:", error);
    return c.json({ error: "Failed to fetch profile" }, 500);
  }
});

// GET /profile/privileged/:userId - Get all user details (admin only)
profile.get("/privileged/:userId", requireAdmin, async (c) => {
  const userId = c.req.param("userId");
  
  // Validate user ID
  const paramValidation = userIdParamSchema.safeParse({ userId });
  if (!paramValidation.success) {
    return c.json({ 
      error: "Invalid user ID",
      details: paramValidation.error.format()
    }, 400);
  }
  
  try {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });
    
    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }
    
    // Return all user fields for admin
    return c.json({ user });
  } catch (error) {
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
    
    if (!user.isActive) {
      return c.json({ error: "Account is deactivated" }, 403);
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
    
    if (!updated[0]) {
      return c.json({ error: "Failed to setup profile" }, 500);
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
    
    // Check if user exists and is active
    const user = await db.query.users.findFirst({
      where: eq(users.id, session.userId),
    });
    
    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }
    
    if (!user.isActive) {
      return c.json({ error: "Account is deactivated" }, 403);
    }
    
    // Build update object (only include provided fields)
    const updateData: any = { updatedAt: new Date() };
    if (updates.name !== undefined) updateData.name = updates.name;
    if (updates.avatarUrl !== undefined) {
      updateData.avatarUrl = updates.avatarUrl || null;
    }
    
    // Update profile
    const updated = await db
      .update(users)
      .set(updateData)
      .where(eq(users.id, session.userId))
      .returning();
    
    if (!updated[0]) {
      return c.json({ error: "Failed to update profile" }, 500);
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
