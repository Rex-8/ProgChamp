import { Hono } from "hono";
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { db } from "../db/index";
import { gameMedia, gameRequests } from "../db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";

const mediaRouter = new Hono();

// Type helper
type GameMedia = typeof gameMedia.$inferSelect;

// Initialize R2 client
const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

// File upload limits
const UPLOAD_LIMITS = {
  image: {
    maxSize: 5 * 1024 * 1024, // 5MB
    allowedTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  },
  video: {
    maxSize: 50 * 1024 * 1024, // 50MB
    allowedTypes: ["video/mp4", "video/webm"],
  },
};

// Validation schemas
const uploadUrlRequestSchema = z.object({
  requestId: z.string(),
  mediaType: z.enum(["image", "video"]),
  filename: z.string(),
  contentType: z.string(),
  fileSize: z.number(),
});

const confirmUploadSchema = z.object({
  requestId: z.string(),
  r2Key: z.string(),
  mediaType: z.enum(["image", "video"]),
  sortOrder: z.number().optional().default(0),
});

// Helper: Sanitize filename
function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[^a-zA-Z0-9.-]/g, "_")
    .toLowerCase()
    .slice(0, 100);
}

// Helper: Validate file type and size
function validateFile(mediaType: "image" | "video", contentType: string, fileSize: number) {
  const limits = UPLOAD_LIMITS[mediaType];
  
  if (!limits.allowedTypes.includes(contentType)) {
    return { valid: false, error: `Invalid content type. Allowed: ${limits.allowedTypes.join(", ")}` };
  }
  
  if (fileSize > limits.maxSize) {
    return { valid: false, error: `File too large. Max size: ${limits.maxSize / 1024 / 1024}MB` };
  }
  
  return { valid: true };
}

// POST /media/upload-url - Get presigned URL for upload
mediaRouter.post("/upload-url", async (c) => {
  const userId = c.req.header("X-User-Id");
  
  if (!userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = await c.req.json();
  const result = uploadUrlRequestSchema.safeParse(body);

  if (!result.success) {
    return c.json({ error: "Invalid request", details: result.error.format() }, 400);
  }

  const { requestId, mediaType, filename, contentType, fileSize } = result.data;

  try {
    // Verify request exists and belongs to user
    const request = await db.query.gameRequests.findFirst({
      where: eq(gameRequests.id, requestId),
    });

    if (!request) {
      return c.json({ error: "Game request not found" }, 404);
    }

    if (request.submittedBy !== userId) {
      return c.json({ error: "Forbidden" }, 403);
    }

    if (request.status !== "pending") {
      return c.json({ error: "Cannot upload to non-pending request" }, 400);
    }

    // Validate file
    const validation = validateFile(mediaType, contentType, fileSize);
    if (!validation.valid) {
      return c.json({ error: validation.error }, 400);
    }

    // Generate unique key
    const mediaId = `media_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    const sanitizedFilename = sanitizeFilename(filename);
    const ext = sanitizedFilename.split(".").pop();
    const r2Key = `temp/requests/${requestId}/${mediaId}.${ext}`;

    // Generate presigned URL (valid for 10 minutes)
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: r2Key,
      ContentType: contentType,
      ContentLength: fileSize,
    });

    const uploadUrl = await getSignedUrl(r2Client as any, command, { expiresIn: 600 });

    return c.json({
      uploadUrl,
      r2Key,
      mediaId,
      expiresIn: 600,
    });
  } catch (error) {
    console.error("Generate upload URL error:", error);
    return c.json({ error: "Failed to generate upload URL" }, 500);
  }
});

// POST /media - Confirm upload and create media record
mediaRouter.post("/", async (c) => {
  const userId = c.req.header("X-User-Id");
  
  if (!userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = await c.req.json();
  const result = confirmUploadSchema.safeParse(body);

  if (!result.success) {
    return c.json({ error: "Invalid request", details: result.error.format() }, 400);
  }

  const { requestId, r2Key, mediaType, sortOrder } = result.data;

  try {
    // Verify request exists and belongs to user
    const request = await db.query.gameRequests.findFirst({
      where: eq(gameRequests.id, requestId),
    });

    if (!request) {
      return c.json({ error: "Game request not found" }, 404);
    }

    if (request.submittedBy !== userId) {
      return c.json({ error: "Forbidden" }, 403);
    }

    // Extract mediaId from r2Key
    const mediaId = r2Key.split("/").pop()?.split(".")[0] || `media_${Date.now()}`;

    // Create media record
    const mediaRecords = await db
      .insert(gameMedia)
      .values({
        id: mediaId,
        gameRequestId: requestId,
        gameId: null, // Will be set when request is approved
        mediaType,
        r2Key,
        sortOrder,
      })
      .returning() as GameMedia[];

    const media = mediaRecords[0];
    
    if (!media) {
      return c.json({ error: "Failed to create media record" }, 500);
    }

    // Generate public URL (if bucket is public)
    const publicUrl = process.env.R2_PUBLIC_URL 
      ? `${process.env.R2_PUBLIC_URL}/${r2Key}`
      : null;

    return c.json({
      media: {
        id: media.id,
        mediaType: media.mediaType,
        r2Key: media.r2Key,
        sortOrder: media.sortOrder,
        url: publicUrl,
        createdAt: media.createdAt,
      },
    });
  } catch (error) {
    console.error("Confirm upload error:", error);
    return c.json({ error: "Failed to create media record" }, 500);
  }
});

// DELETE /media/:id - Delete media (only if unused)
mediaRouter.delete("/:id", async (c) => {
  const mediaId = c.req.param("id");
  const userId = c.req.header("X-User-Id");
  
  if (!userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    // Get media record
    const media = await db.query.gameMedia.findFirst({
      where: eq(gameMedia.id, mediaId),
    });

    if (!media) {
      return c.json({ error: "Media not found" }, 404);
    }

    // Verify ownership via gameRequest
    const request = await db.query.gameRequests.findFirst({
      where: eq(gameRequests.id, media.gameRequestId),
    });

    if (!request || request.submittedBy !== userId) {
      return c.json({ error: "Forbidden" }, 403);
    }

    // Cannot delete if already attached to approved game
    if (media.gameId) {
      return c.json({ error: "Cannot delete media attached to approved game" }, 400);
    }

    // Delete from R2
    await r2Client.send(new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: media.r2Key,
    }));

    // Delete from database
    await db.delete(gameMedia).where(eq(gameMedia.id, mediaId));

    return c.json({ success: true });
  } catch (error) {
    console.error("Delete media error:", error);
    return c.json({ error: "Failed to delete media" }, 500);
  }
});

// GET /media/:id - Get media details
mediaRouter.get("/:id", async (c) => {
  const mediaId = c.req.param("id");

  try {
    const media = await db.query.gameMedia.findFirst({
      where: eq(gameMedia.id, mediaId),
    });

    if (!media) {
      return c.json({ error: "Media not found" }, 404);
    }

    // Generate public URL or presigned URL
    let url: string;
    
    if (process.env.R2_PUBLIC_URL) {
      // Public bucket - direct URL
      url = `${process.env.R2_PUBLIC_URL}/${media.r2Key}`;
    } else {
      // Private bucket - generate presigned URL (valid for 1 hour)
      const command = new GetObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME!,
        Key: media.r2Key,
      });
      url = await getSignedUrl(r2Client as any, command, { expiresIn: 3600 });
    }

    return c.json({
      id: media.id,
      mediaType: media.mediaType,
      url,
      sortOrder: media.sortOrder,
      createdAt: media.createdAt,
    });
  } catch (error) {
    console.error("Get media error:", error);
    return c.json({ error: "Failed to fetch media" }, 500);
  }
});

// GET /media/request/:requestId - Get all media for a request
mediaRouter.get("/request/:requestId", async (c) => {
  const requestId = c.req.param("requestId");
  const userId = c.req.header("X-User-Id");

  try {
    // Verify ownership
    const request = await db.query.gameRequests.findFirst({
      where: eq(gameRequests.id, requestId),
    });

    if (!request) {
      return c.json({ error: "Request not found" }, 404);
    }

    // Only owner or admin can view request media
    if (userId && request.submittedBy !== userId) {
      // TODO: Check if user is admin
      return c.json({ error: "Forbidden" }, 403);
    }

    // Get all media for this request
    const mediaList = await db.query.gameMedia.findMany({
      where: eq(gameMedia.gameRequestId, requestId),
      orderBy: (gameMedia, { asc }) => [asc(gameMedia.sortOrder)],
    });

    // Generate URLs
    const mediaWithUrls = await Promise.all(
      mediaList.map(async (media) => {
        let url: string;
        
        if (process.env.R2_PUBLIC_URL) {
          url = `${process.env.R2_PUBLIC_URL}/${media.r2Key}`;
        } else {
          const command = new GetObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME!,
            Key: media.r2Key,
          });
          url = await getSignedUrl(r2Client as any, command, { expiresIn: 3600 });
        }

        return {
          id: media.id,
          mediaType: media.mediaType,
          url,
          sortOrder: media.sortOrder,
          createdAt: media.createdAt,
        };
      })
    );

    return c.json({ media: mediaWithUrls });
  } catch (error) {
    console.error("Get request media error:", error);
    return c.json({ error: "Failed to fetch media" }, 500);
  }
});

export default mediaRouter;