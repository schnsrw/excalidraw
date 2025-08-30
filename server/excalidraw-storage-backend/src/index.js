import express from "express";
import morgan from "morgan";
import Redis from "ioredis";

const app = express();

// Config
const PORT = process.env.PORT || 8080;
const STORAGE_URI = process.env.STORAGE_URI || process.env.REDIS_URL || "redis://redis:6379";
const TTL_SECONDS = parseInt(process.env.TTL_SECONDS || "86400", 10); // default 24h
const MAX_BYTES = parseInt(process.env.MAX_BYTES || String(3 * 1024 * 1024), 10); // 3 MiB

// Redis client
const redis = new Redis(STORAGE_URI, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});

redis.on("error", (err) => {
  console.error("Redis error:", err);
});

await redis.connect();

app.use(morgan("tiny"));

// Buffer bodies for binary uploads. Limit enforced.
app.use((req, res, next) => {
  if (req.method === "PUT" || req.method === "POST") {
    let chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BYTES) {
        res.status(413).send("Payload too large");
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      req.rawBody = Buffer.concat(chunks);
      next();
    });
  } else {
    next();
  }
});

// Health check
app.get("/healthz", (req, res) => {
  res.json({ ok: true });
});

// PUT /files/<key...>
app.put("/files/*", async (req, res) => {
  try {
    const key = req.params[0];
    if (!key || !req.rawBody) {
      return res.status(400).json({ error: "Missing key or body" });
    }
    await redis.set(key, req.rawBody, "EX", TTL_SECONDS);
    res.setHeader("Cache-Control", `public, max-age=${Math.min(TTL_SECONDS, 86400)}`);
    return res.status(204).end();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to store object" });
  }
});

// GET /files/<key...>
app.get("/files/*", async (req, res) => {
  try {
    const key = req.params[0];
    if (!key) {
      return res.status(400).json({ error: "Missing key" });
    }
    const value = await redis.getBuffer(key);
    if (!value) {
      return res.status(404).json({ error: "Not found" });
    }
    res.setHeader("Content-Type", "application/octet-stream");
    const ttl = await redis.ttl(key);
    if (ttl && ttl > 0) {
      res.setHeader("Cache-Control", `public, max-age=${Math.min(ttl, 86400)}`);
    } else {
      res.setHeader("Cache-Control", "no-store");
    }
    return res.status(200).end(value);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to read object" });
  }
});

// DELETE /files/<key...>
app.delete("/files/*", async (req, res) => {
  try {
    const key = req.params[0];
    if (!key) {
      return res.status(400).json({ error: "Missing key" });
    }
    await redis.del(key);
    return res.status(204).end();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to delete object" });
  }
});

// Scenes (JSON) with TTL
// Only attach JSON parser on the /scenes prefix to avoid interfering with binary uploads
app.use("/scenes", express.json({ limit: `${Math.floor(MAX_BYTES / 1024)}kb` }));
// PUT /scenes/:roomId
app.put("/scenes/:roomId", async (req, res) => {
  try {
    const { roomId } = req.params;
    if (!roomId) return res.status(400).json({ error: "Missing roomId" });
    const body = req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : req.rawBody?.toString();
    if (!body) return res.status(400).json({ error: "Missing body" });
    await redis.set(`scenes/${roomId}`, body, "EX", TTL_SECONDS);
    res.setHeader("Cache-Control", `no-store`);
    return res.status(204).end();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to store scene" });
  }
});

// GET /scenes/:roomId
app.get("/scenes/:roomId", async (req, res) => {
  try {
    const { roomId } = req.params;
    if (!roomId) return res.status(400).json({ error: "Missing roomId" });
    const value = await redis.get(`scenes/${roomId}`);
    if (!value) return res.status(404).json({ error: "Not found" });
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).end(value);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to load scene" });
  }
});

app.listen(PORT, () => {
  console.log(`storage backend listening on :${PORT}`);
});
