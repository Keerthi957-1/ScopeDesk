const express = require("express");
const bcrypt = require("bcryptjs");

const router = express.Router();

// Health check for the authentication API
router.get("/", (req, res) => {
  res.json({
    message: "ScopeDesk authentication API is running!"
  });
});

// Signup validation (MySQL storage will be added later)
router.post("/signup", async (req, res) => {
  try {
    const { username, password, role } = req.body;

    if (
      typeof username !== "string" ||
      typeof password !== "string" ||
      typeof role !== "string"
    ) {
      return res.status(400).json({
        message: "Username, password, and role are required."
      });
    }

    const cleanUsername = username.trim();

    if (cleanUsername.length < 3 || cleanUsername.length > 50) {
      return res.status(400).json({
        message: "Username must be between 3 and 50 characters."
      });
    }

    if (!["client", "vendor"].includes(role)) {
      return res.status(400).json({
        message: "Role must be client or vendor."
      });
    }

    if (
      password.length < 8 ||
      Buffer.byteLength(password, "utf8") > 72
    ) {
      return res.status(400).json({
        message: "Password must be at least 8 characters and no more than 72 bytes."
      });
    }

    // Hash the password before storing it in the database.
    const passwordHash = await bcrypt.hash(password, 12);

    // TODO: Insert cleanUsername, passwordHash, and role into MySQL.
    // Do not return the password hash or claim the account was created.

    return res.status(501).json({
      message: "Validation works, but account creation is not connected to MySQL yet."
    });
  } catch (error) {
    console.error("Signup error:", error.message);
    return res.status(500).json({
      message: "An unexpected error occurred."
    });
  }
});

// Login will be implemented with MySQL account lookup and password verification.
router.post("/login", (req, res) => {
  return res.status(501).json({
    message: "Login is not connected yet."
  });
});

module.exports = router;