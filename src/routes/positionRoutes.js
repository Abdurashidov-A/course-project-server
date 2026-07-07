const express = require("express");
const prisma = require("../lib/prisma");

const router = express.Router();

function getDevUserId(req) {
  return req.header("x-dev-user-id") || null;
}

async function getCurrentUserWithRoles(userId) {
  return prisma.user.findUnique({
    where: { id: userId },
    include: {
      roles: {
        include: {
          role: true,
        },
      },
    },
  });
}

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

router.get("/:positionId/cvs", async (req, res) => {
  try {
    const userId = getDevUserId(req);
    const positionId = Number(req.params.positionId);

    if (!userId) {
      return res
        .status(401)
        .json({ message: "Dev user id header is required" });
    }

    if (!Number.isInteger(positionId) || positionId <= 0) {
      return res.status(400).json({
        message: "Valid position id is required",
      });
    }

    const currentUser = await getCurrentUserWithRoles(userId);

    if (!currentUser) {
      return res.status(401).json({
        message: "Current user not found",
      });
    }

    const roleNames = currentUser.roles.map((userRole) => userRole.role.name);
    const canAccess =
      roleNames.includes("RECRUITER") || roleNames.includes("ADMIN");

    if (!canAccess) {
      return res.status(403).json({
        message: "You do not have access to published CVs for this position",
      });
    }

    const position = await prisma.position.findUnique({
      where: {
        id: positionId,
      },
      select: {
        id: true,
        title: true,
        shortDescription: true,
      },
    });

    if (!position) {
      return res.status(404).json({
        message: "Position not found",
      });
    }

    const cvs = await prisma.cv.findMany({
      where: {
        positionId,
        status: "PUBLISHED",
      },
      orderBy: {
        updatedAt: "desc",
      },
      select: {
        id: true,
        status: true,
        version: true,
        createdAt: true,
        updatedAt: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    res.json({
      position,
      cvs: cvs.map((cv) => ({
        id: cv.id,
        status: cv.status,
        version: cv.version,
        createdAt: cv.createdAt,
        updatedAt: cv.updatedAt,
        candidate: cv.user,
      })),
    });
  } catch (error) {
    console.error("GET /api/positions/:positionId/cvs error:", error);
    res.status(500).json({
      message: "Failed to load published CVs for this position",
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

router.put("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      title,
      shortDescription,
      isPublic = true,
      maxProjects = 3,
      version,
      attributes = [],
    } = req.body;

    if (!id) {
      return res.status(400).json({
        message: "Valid position id is required",
      });
    }

    if (!title || typeof version !== "number") {
      return res.status(400).json({
        message: "Title and version are required",
      });
    }

    const updateResult = await prisma.position.updateMany({
      where: {
        id,
        version,
      },
      data: {
        title,
        shortDescription: shortDescription || null,
        isPublic,
        maxProjects: Number(maxProjects) || 3,
        version: {
          increment: 1,
        },
      },
    });

    if (updateResult.count === 0) {
      return res.status(409).json({
        message:
          "Position was changed by someone else. Please reload and try again.",
      });
    }

    await prisma.positionAttribute.deleteMany({
      where: { positionId: id },
    });

    if (attributes.length > 0) {
      await prisma.positionAttribute.createMany({
        data: attributes.map((item, index) => ({
          positionId: id,
          attributeId: item.attributeId,
          isRequired: Boolean(item.isRequired),
          sortOrder: index + 1,
        })),
      });
    }

    const updatedPosition = await prisma.position.findUnique({
      where: { id },
      include: {
        attributes: {
          orderBy: { sortOrder: "asc" },
          include: {
            attribute: true,
          },
        },
      },
    });

    res.json(updatedPosition);
  } catch (error) {
    console.error("PUT /api/positions/:id error:", error);

    res.status(500).json({
      message: "Failed to update position",
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
