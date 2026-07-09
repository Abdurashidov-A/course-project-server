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

function canManagePositions(user) {
  return user?.roles?.some((userRole) => {
    const roleName = userRole.role?.name;

    return roleName === "RECRUITER" || roleName === "ADMIN";
  });
}

function sanitizeProjectTags(tags) {
  if (tags === undefined) {
    return [];
  }

  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) {
    return null;
  }

  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

async function generateDuplicateTitle(tx, sourceTitle) {
  const baseTitle = `${sourceTitle} Copy`;
  const existingTitles = await tx.position.findMany({
    where: {
      title: {
        startsWith: baseTitle,
      },
    },
    select: {
      title: true,
    },
  });

  const usedTitles = new Set(existingTitles.map((position) => position.title));

  if (!usedTitles.has(baseTitle)) {
    return baseTitle;
  }

  for (let index = 2; index <= 50; index += 1) {
    const candidateTitle = `${baseTitle} ${index}`;

    if (!usedTitles.has(candidateTitle)) {
      return candidateTitle;
    }
  }

  return `${baseTitle} ${Date.now()}`;
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
        projectTags: true,
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

router.post("/:id/duplicate", async (req, res) => {
  try {
    const userId = getDevUserId(req);
    const id = Number(req.params.id);

    if (!userId) {
      return res
        .status(401)
        .json({ message: "Dev user id header is required" });
    }

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        message: "Valid position id is required",
      });
    }

    const currentUser = await getCurrentUserWithRoles(userId);

    if (!currentUser) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    if (!canManagePositions(currentUser)) {
      return res.status(403).json({
        message: "Only recruiters/admins can duplicate positions",
      });
    }

    const duplicatedPosition = await prisma.$transaction(async (tx) => {
      const sourcePosition = await tx.position.findUnique({
        where: { id },
        include: {
          attributes: {
            orderBy: {
              sortOrder: "asc",
            },
            include: {
              attribute: true,
            },
          },
        },
      });

      if (!sourcePosition) {
        return null;
      }

      const duplicatedTitle = await generateDuplicateTitle(tx, sourcePosition.title);

      return tx.position.create({
        data: {
          title: duplicatedTitle,
          shortDescription: sourcePosition.shortDescription,
          isPublic: sourcePosition.isPublic,
          maxProjects: sourcePosition.maxProjects,
          projectTags: sourcePosition.projectTags || [],
          attributes: {
            create: sourcePosition.attributes.map((item) => ({
              attributeId: item.attributeId,
              isRequired: item.isRequired,
              sortOrder: item.sortOrder,
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
    });

    if (!duplicatedPosition) {
      return res.status(404).json({
        message: "Position not found",
      });
    }

    res.status(201).json(duplicatedPosition);
  } catch (error) {
    console.error("POST /api/positions/:id/duplicate error:", error);

    res.status(500).json({
      message: "Failed to duplicate position",
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
      projectTags = [],
      attributes = [],
    } = req.body;

    if (!title) {
      return res.status(400).json({
        message: "Position title is required",
      });
    }

    const sanitizedProjectTags = sanitizeProjectTags(projectTags);

    if (sanitizedProjectTags === null) {
      return res.status(400).json({
        message: "projectTags must be an array of strings",
      });
    }

    const position = await prisma.position.create({
      data: {
        title,
        shortDescription: shortDescription || null,
        isPublic,
        maxProjects: Number(maxProjects) || 3,
        projectTags: sanitizedProjectTags,
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
      projectTags = [],
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

    const sanitizedProjectTags = sanitizeProjectTags(projectTags);

    if (sanitizedProjectTags === null) {
      return res.status(400).json({
        message: "projectTags must be an array of strings",
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
        projectTags: sanitizedProjectTags,
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
