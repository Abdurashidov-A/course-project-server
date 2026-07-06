const express = require("express");
const prisma = require("../lib/prisma");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const positions = await prisma.position.findMany({
      orderBy: { updatedAt: "desc" },
      include: {
        attributes: {
          orderBy: { sortOrder: "asc" },
          include: {
            attribute: true,
          },
        },
      },
    });

    res.json(positions);
  } catch (error) {
    console.error("GET /api/positions error:", error);
    res.status(500).json({
      message: "Failed to load positions",
    });
  }
});

module.exports = router;
