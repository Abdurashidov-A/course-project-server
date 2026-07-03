const express = require("express");
const prisma = require("../lib/prisma");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const attributes = await prisma.attribute.findMany({
      orderBy: [{ category: "asc" }, { name: "asc" }],
      include: {
        options: {
          orderBy: { sortOrder: "asc" },
        },
      },
    });

    res.json(attributes);
  } catch (error) {
    console.error("GET /api/attributes error:", error);
    res.status(500).json({ message: "Failed to load attributes" });
  }
});

module.exports = router;
