import { Hono } from "hono";
import { cors } from "hono/cors";
import auth from "./routes/auth";
import games from "./routes/games";
import profile from "./routes/profile";
import media from "./routes/media";

const app = new Hono();

// CORS middleware
app.use("/*", cors({
  origin: process.env.FRONTEND_URL || "http://localhost:5173",
  credentials: true, // Important for cookies
}));

// Health check
app.get("/", (c) => c.text("OK"));

// Mount routes
app.route("/auth", auth);
app.route("/profile", profile);
app.route("/games", games);
app.route("/media", media);

export default app;

if (import.meta.main) {
  Bun.serve({
    fetch: app.fetch,
    port: 9210,
  });

  console.log("Backend running on http://localhost:9210");
}