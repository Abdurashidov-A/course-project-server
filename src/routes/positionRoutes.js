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

router.post("/", async (req, res) => {
  try {
    const {
      title,
      shortDescription,
      isPublic = true,
      maxProjects = 3,
      attributes = [],
    } = req.body;

    if (!title) {
      return res.status(400).json({
        message: "Position title is required",
      });
    }

    const position = await prisma.position.create({
      data: {
        title,
        shortDescription: shortDescription || null,
        isPublic,
        maxProjects: Number(maxProjects) || 3,
        attributes: {
          create: attributes.map((item, index) => ({
            attributeId: item.attributeId,
            isRequired: Boolean(item.isRequired),
            sortOrder: index + 1,
          })),
        },
      },
      include: {
        attributes: {
          orderBy: { sortOrder: "asc" },
          include: {
            attribute: true,
          },
        },
      },
    });

    res.status(201).json(position);
  } catch (error) {
    console.error("POST /api/positions error:", error);

    res.status(500).json({
      message: "Failed to create position",
    });
  }
});

router.delete("/", async (req, res) => {
  try {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        message: "Position ids are required",
      });
    }

    const deletedPositions = await prisma.position.deleteMany({
      where: {
        id: {
          in: ids,
        },
      },
    });

    res.json({
      deletedCount: deletedPositions.count,
    });
  } catch (error) {
    console.error("DELETE /api/positions error:", error);

    res.status(500).json({
      message: "Failed to delete positions",
    });
  }
});

module.exports = router;
