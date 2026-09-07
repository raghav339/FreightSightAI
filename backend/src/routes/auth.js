// backend/src/routes/auth.js
// Local signup/login for the authenticated forecasting workflow.
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db");
const { requireAuth, JWT_SECRET } = require("../middleware/auth");
const { authLimiter } = require("../middleware/rateLimit");

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;


function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, is_verified: !!u.is_verified, role: u.role || "user" };
}

function issueToken(u) {
  return jwt.sign({ id: u.id, email: u.email, is_verified: !!u.is_verified }, JWT_SECRET, {
    expiresIn: "7d",
  });
}

// POST /api/auth/register
router.post("/auth/register", authLimiter, async (req, res) => {
  const { name, email, password } = req.body || {};
  const errors = [];

  if (!name || typeof name !== "string" || !name.trim()) errors.push("name is required");
  if (!email || typeof email !== "string" || !EMAIL_RE.test(email.trim())) errors.push("a valid email is required");
  if (!password || typeof password !== "string" || password.length < 8) {
    errors.push("password must be at least 8 characters");
  }
  if (errors.length) return res.status(400).json({ error: "Validation failed", details: errors });

  const normalizedEmail = email.trim().toLowerCase();

  try {
    const existing = await db.query("SELECT id FROM users WHERE email = ?", [normalizedEmail]);
    if (existing.length) {
      return res.status(409).json({ error: "An account with that email already exists." });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const insertResult = await db.run(
      `INSERT INTO users (name, email, password_hash, is_verified)
       VALUES (?, ?, ?, 1)`,
      [name.trim(), normalizedEmail, passwordHash]
    );

    const user = { id: insertResult.lastID, name: name.trim(), email: normalizedEmail, is_verified: true };

    res.status(201).json({
      message: "Account created successfully.",
      user: publicUser(user),
      token: issueToken(user),
    });
  } catch (err) {
    console.error("register failed:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/auth/login
router.post("/auth/login", authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  try {
    const rows = await db.query("SELECT * FROM users WHERE email = ?", [email.trim().toLowerCase()]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: "Invalid email or password." });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid email or password." });

    res.json({ user: publicUser(user), token: issueToken(user) });
  } catch (err) {
    console.error("login failed:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/auth/me  (auth required) — used by the frontend to restore a session on refresh
router.get("/auth/me", requireAuth, async (req, res) => {
  try {
    const rows = await db.query("SELECT * FROM users WHERE id = ?", [req.user.id]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: "Account not found. Please log in again." });
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error("me failed:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;