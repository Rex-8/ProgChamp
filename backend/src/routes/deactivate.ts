import { Hono } from "hono";
import { db } from "../../db/index";
import { users } from "../../db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireAdmin } from "../../lib/admin";

const deactivateRouter = new Hono();

// Validation schema
const deactivateUserSchema = z.object({
  reason: z.string().min(1, "Reason is required").max(500, "Reason too long"),
});

// PATCH /deactivate/:id - Deactivate a user (admin only)
deactivateRouter.patch("/:id", requireAdmin, async (c) => {
  const targetUserId = c.req.param("id");
  const adminUser = c.get("adminUser");
  
  try {
    // Validate request body
    const body = await c.req.json();
    const result = deactivateUserSchema.safeParse(body);
    
    if (!result.success) {
      return c.json({ 
        error: "Invalid request data", 
        details: result.error.format() 
      }, 400);
    }
    
    const { reason } = result.data;
    
    // Validate user ID format
    if (!targetUserId || targetUserId.trim() === "") {
      return c.json({ error: "Invalid user ID" }, 400);
    }
    
    // Check if target user exists
    const targetUser = await db.query.users.findFirst({
      where: eq(users.id, targetUserId),
    });
    
    if (!targetUser) {
      return c.json({ error: "User not found" }, 404);
    }
    
    // Check if already deactivated
    if (!targetUser.isActive) {
      return c.json({ 
        error: "User already deactivated",
        deactivationInfo: {
          deactivatedAt: targetUser.deactivatedAt,
          deactivatedBy: targetUser.deactivatedBy,
          deactivationReason: targetUser.deactivationReason,
        }
      }, 400);
    }
    
    // Prevent admin from deactivating themselves
    if (targetUserId === adminUser.id) {
      return c.json({ 
        error: "Cannot deactivate your own account",
        message: "Ask another admin to deactivate your account"
      }, 400);
    }
    
    // Deactivate the user
    const deactivatedAt = new Date();
    const updated = await db
      .update(users)
      .set({
        isActive: false,
        deactivatedAt,
        deactivatedBy: adminUser.id,
        deactivationReason: reason,
        updatedAt: deactivatedAt,
      })
      .where(eq(users.id, targetUserId))
      .returning();
    
    if (!updated[0]) {
      return c.json({ error: "Failed to deactivate user" }, 500);
    }
    
    return c.json({
      success: true,
      message: "User deactivated successfully",
      deactivation: {
        userId: updated[0].id,
        email: updated[0].email,
        name: updated[0].name,
        isActive: updated[0].isActive,
        deactivatedAt: updated[0].deactivatedAt,
        deactivatedBy: updated[0].deactivatedBy,
        deactivationReason: updated[0].deactivationReason,
      },
    });
  } catch (error) {
    console.error("Deactivate user error:", error);
    return c.json({ error: "Failed to deactivate user" }, 500);
  }
});

export default deactivateRouter;