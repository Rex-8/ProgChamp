import { Hono } from "hono";
import { db } from "../../db/index";
import { 
  users, 
  games, 
  gameReactions, 
  gameSuperlikes, 
  gameViews,
  gameRequests,
  userRequests,
  tags,
  adminActions,
  gameTags,
  gameMedia
} from "../../db/schema";
import { eq, or } from "drizzle-orm";
import { requireAdmin } from "../../lib/admin";

const deleteRouter = new Hono();

// DELETE /:id - Permanently delete a user (admin only)
deleteRouter.delete("/:id", requireAdmin, async (c) => {
  const targetUserId = c.req.param("id");
  const adminUser = c.get("adminUser");
  
  try {
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
    
    // Prevent admin from deleting themselves
    if (targetUserId === adminUser.id) {
      return c.json({ 
        error: "Cannot delete your own account",
        message: "Ask another admin to delete your account"
      }, 400);
    }
    
    // Safety check: Only allow deletion of deactivated users
    if (targetUser.isActive) {
      return c.json({ 
        error: "Cannot delete active user",
        message: "Deactivate the user first, then delete after review period"
      }, 400);
    }
    
    // Store user info for response before deletion
    const deletedUserInfo = {
      id: targetUser.id,
      email: targetUser.email,
      name: targetUser.name,
      wasDeactivatedAt: targetUser.deactivatedAt,
      wasDeactivatedBy: targetUser.deactivatedBy,
      deactivationReason: targetUser.deactivationReason,
    };
    
    // CASCADE DELETE: Manually delete all related records
    // This ensures clean deletion and prevents orphaned records
    
    // 1. Get all games created by this user
    const userGames = await db.query.games.findMany({
      where: eq(games.createdBy, targetUserId),
    });
    const userGameIds = userGames.map(g => g.id);
    
    // 2. Delete game media for user's games
    if (userGameIds.length > 0) {
      for (const gameId of userGameIds) {
        await db.delete(gameMedia).where(eq(gameMedia.gameId, gameId));
      }
    }
    
    // 3. Delete game tags for user's games
    if (userGameIds.length > 0) {
      for (const gameId of userGameIds) {
        await db.delete(gameTags).where(eq(gameTags.gameId, gameId));
      }
    }
    
    // 4. Delete reactions to user's games (from other users)
    if (userGameIds.length > 0) {
      for (const gameId of userGameIds) {
        await db.delete(gameReactions).where(eq(gameReactions.gameId, gameId));
      }
    }
    
    // 5. Delete superlikes to user's games (from other users)
    if (userGameIds.length > 0) {
      for (const gameId of userGameIds) {
        await db.delete(gameSuperlikes).where(eq(gameSuperlikes.gameId, gameId));
      }
    }
    
    // 6. Delete views of user's games
    if (userGameIds.length > 0) {
      for (const gameId of userGameIds) {
        await db.delete(gameViews).where(eq(gameViews.gameId, gameId));
      }
    }
    
    // 7. Delete the games themselves
    await db.delete(games).where(eq(games.createdBy, targetUserId));
    
    // 8. Delete user's reactions to other games
    await db.delete(gameReactions).where(eq(gameReactions.userId, targetUserId));
    
    // 9. Delete user's superlikes to other games
    await db.delete(gameSuperlikes).where(eq(gameSuperlikes.userId, targetUserId));
    
    // 10. Delete user's views
    await db.delete(gameViews).where(eq(gameViews.userId, targetUserId));
    
    // 11. Get user's game requests to delete associated media
    const userGameRequests = await db.query.gameRequests.findMany({
      where: eq(gameRequests.submittedBy, targetUserId),
    });
    const requestIds = userGameRequests.map(r => r.id);
    
    // 12. Delete media for user's game requests
    if (requestIds.length > 0) {
      for (const requestId of requestIds) {
        await db.delete(gameMedia).where(eq(gameMedia.gameRequestId, requestId));
      }
    }
    
    // 13. Delete user's game requests
    await db.delete(gameRequests).where(eq(gameRequests.submittedBy, targetUserId));
    
    // 14. Delete user's user requests (appeals)
    await db.delete(userRequests).where(eq(userRequests.submittedBy, targetUserId));
    
    // 15. Delete tags created by user
    await db.delete(tags).where(eq(tags.createdBy, targetUserId));
    
    // 16. Delete admin actions WHERE user was the admin
    await db.delete(adminActions).where(eq(adminActions.adminId, targetUserId));
    
    // 17. Update any users who were deactivated by this user (set to null)
    await db
      .update(users)
      .set({ deactivatedBy: null })
      .where(eq(users.deactivatedBy, targetUserId));
    
    // 18. Finally, delete the user
    await db.delete(users).where(eq(users.id, targetUserId));
    
    return c.json({
      success: true,
      message: "User and all associated data permanently deleted",
      deletedUser: deletedUserInfo,
      deletedRecords: {
        games: userGameIds.length,
        gameRequests: requestIds.length,
        note: "All reactions, superlikes, views, tags, and media also deleted"
      }
    });
  } catch (error) {
    console.error("Delete user error:", error);
    return c.json({ error: "Failed to delete user" }, 500);
  }
});

export default deleteRouter;
