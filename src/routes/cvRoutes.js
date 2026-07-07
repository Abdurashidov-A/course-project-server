const express = require("express");
const prisma = require("../lib/prisma");

const router = express.Router();

function getDevUserId(req) {
  return req.header("x-dev-user-id") || null;
}

router.get("/my", async (req, res) => {
  try {
    const userId = getDevUserId(req);

    if (!userId) {
      return res
        .status(401)
        .json({ message: "Dev user id header is required" });
    }

    const cvs = await prisma.cv.findMany({
      where: {
        userId,
      },
      orderBy: {
        updatedAt: "desc",
      },
      include: {
        position: true,
      },
    });

    res.json(cvs);
  } catch (error) {
    console.error("GET /api/cvs/my error:", error);
    res.status(500).json({
      message: "Failed to load CVs",
    });
  }
});

router.post("/", async (req, res) => {
  try {
    const userId = getDevUserId(req);
    const positionId = Number(req.body?.positionId);

    if (!userId) {
      return res
        .status(401)
        .json({ message: "Dev user id header is required" });
    }

    if (!Number.isInteger(positionId)) {
      return res.status(400).json({
        message: "Valid position id is required",
      });
    }

    const position = await prisma.position.findUnique({
      where: {
        id: positionId,
      },
    });

    if (!position) {
      return res.status(404).json({
        message: "Position not found",
      });
    }

    const cv = await prisma.cv.create({
      data: {
        userId,
        positionId,
      },
      include: {
        position: true,
      },
    });

    res.status(201).json(cv);
  } catch (error) {
    console.error("POST /api/cvs error:", error);

    if (error.code === "P2002") {
      return res.status(409).json({
        message: "CV for this position already exists for the current user",
      });
    }

    res.status(500).json({
      message: "Failed to create CV",
    });
  }
});

module.exports = router;
