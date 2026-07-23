const express = require("express");
const prisma = require("../lib/prisma");
const {
  buildCandidatePositionAccessMap,
  buildPositionAccessMeta,
  canCandidateAccessPosition,
  validateAndNormalizeAccessRules,
} = require("../utils/positionAccess");

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

function getRoleNames(user) {
  return user?.roles?.map((userRole) => userRole.role?.name) || [];
}

function canManagePositions(user) {
  const roleNames = getRoleNames(user);

  return roleNames.includes("RECRUITER") || roleNames.includes("ADMIN");
}

async function canAccessPositionDiscussions(user, position) {
  const roleNames = getRoleNames(user);

  if (roleNames.includes("RECRUITER") || roleNames.includes("ADMIN")) {
    return true;
  }

  if (roleNames.includes("CANDIDATE")) {
    return (await canCandidateAccessPosition(user.id, position)).accessible;
  }

  return false;
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

function serializeAccessRule(rule) {
  return {
    id: rule.id,
    attributeId: rule.attributeId,
    operator: rule.operator,
    stringValue: rule.stringValue,
    numericValue: rule.numericValue,
    booleanValue: rule.booleanValue,
    dateValue: rule.dateValue,
    sortOrder: rule.sortOrder,
    attribute: rule.attribute
      ? {
          id: rule.attribute.id,
          name: rule.attribute.name,
          type: rule.attribute.type,
        }
      : undefined,
  };
}

function serializePosition(position, options = {}) {
  const { includeAccessRules = false, isAccessible } = options;
  const accessMeta = buildPositionAccessMeta(position);

  return {
    id: position.id,
    title: position.title,
    shortDescription: position.shortDescription,
    isPublic: position.isPublic,
    maxProjects: position.maxProjects,
    projectTags: position.projectTags,
    version: position.version,
    createdAt: position.createdAt,
    updatedAt: position.updatedAt,
    attributes: position.attributes,
    ...accessMeta,
    ...(typeof isAccessible === "boolean" ? { isAccessible } : {}),
    ...(includeAccessRules
      ? {
          accessRules: (position.accessRules || []).map(serializeAccessRule),
        }
      : {}),
  };
}

function getPositionInclude() {
  return {
    accessRules: {
      orderBy: { sortOrder: "asc" },
      include: {
        attribute: {
          include: {
            options: {
              orderBy: {
                sortOrder: "asc",
              },
            },
          },
        },
      },
    },
    attributes: {
      orderBy: { sortOrder: "asc" },
      include: {
        attribute: {
          include: {
            options: {
              orderBy: {
                sortOrder: "asc",
              },
            },
          },
        },
      },
    },
  };
}

async function loadAttributesByIds(attributeIds) {
  if (!Array.isArray(attributeIds) || attributeIds.length === 0) {
    return new Map();
  }

  const attributes = await prisma.attribute.findMany({
    where: {
      id: {
        in: attributeIds,
      },
    },
    include: {
      options: {
        orderBy: {
          sortOrder: "asc",
        },
      },
    },
  });

  return new Map(attributes.map((attribute) => [attribute.id, attribute]));
}

async function getNormalizedAccessRulesOrError(accessRules) {
  const attributeIds = accessRules
    .map((rule) => Number(rule?.attributeId))
    .filter((attributeId) => Number.isInteger(attributeId) && attributeId > 0);

  const attributesById = await loadAttributesByIds(attributeIds);

  return validateAndNormalizeAccessRules(accessRules, attributesById);
}

router.get("/", async (req, res) => {
  try {
    const userId = getDevUserId(req);

    if (!userId) {
      return res
        .status(401)
        .json({ message: "Dev user id header is required" });
    }

    const currentUser = await getCurrentUserWithRoles(userId);

    if (!currentUser) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    const positions = await prisma.position.findMany({
      orderBy: { updatedAt: "desc" },
      include: getPositionInclude(),
    });

    const roleNames = getRoleNames(currentUser);
    const isCandidateOnly =
      roleNames.includes("CANDIDATE") &&
      !roleNames.includes("RECRUITER") &&
      !roleNames.includes("ADMIN");

    if (isCandidateOnly) {
      const accessMap = await buildCandidatePositionAccessMap(
        userId,
        positions,
      );

      return res.json(
        positions
          .filter((position) => accessMap.get(position.id)?.accessible)
          .map((position) =>
            serializePosition(position, {
              isAccessible: true,
            }),
          ),
      );
    }

    res.json(
      positions.map((position) =>
        serializePosition(position, {
          includeAccessRules: true,
          isAccessible: true,
        }),
      ),
    );
  } catch (error) {
    console.error("GET /api/positions error:", error);
    res.status(500).json({
      message: "Failed to load positions",
    });
  }
});

router.get("/count", async (req, res) => {
  try {
    const count = await prisma.position.count();

    return res.status(200).json({ count });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to load position count",
    });
  }
});

router

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

    const roleNames = getRoleNames(currentUser);
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
        likes: {
          where: {
            userId,
          },
          select: {
            id: true,
          },
        },
        _count: {
          select: {
            likes: true,
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
        likesCount: cv._count.likes,
        likedByCurrentUser: Array.isArray(cv.likes)
          ? cv.likes.length > 0
          : false,
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

router.get("/:positionId/discussions", async (req, res) => {
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

    const [currentUser, position] = await Promise.all([
      getCurrentUserWithRoles(userId),
      prisma.position.findUnique({
        where: {
          id: positionId,
        },
        include: {
          accessRules: {
            orderBy: {
              sortOrder: "asc",
            },
            include: {
              attribute: true,
            },
          },
        },
      }),
    ]);

    if (!currentUser) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    if (!position) {
      return res.status(404).json({
        message: "Position not found",
      });
    }

    if (!(await canAccessPositionDiscussions(currentUser, position))) {
      return res.status(403).json({
        message: "You do not have access to discussions for this position",
      });
    }

    const posts = await prisma.positionDiscussionPost.findMany({
      where: {
        positionId,
      },
      orderBy: [
        {
          createdAt: "asc",
        },
        {
          id: "asc",
        },
      ],
      take: 100,
      select: {
        id: true,
        content: true,
        createdAt: true,
        author: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    res.json({
      positionId,
      posts,
    });
  } catch (error) {
    console.error("GET /api/positions/:positionId/discussions error:", error);
    res.status(500).json({
      message: "Failed to load discussions",
    });
  }
});

router.post("/:positionId/discussions", async (req, res) => {
  try {
    const userId = getDevUserId(req);
    const positionId = Number(req.params.positionId);
    const trimmedContent =
      typeof req.body?.content === "string" ? req.body.content.trim() : "";

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

    if (!trimmedContent) {
      return res.status(400).json({
        message: "Discussion content is required",
      });
    }

    if (trimmedContent.length > 1000) {
      return res.status(400).json({
        message: "Discussion content must be 1000 characters or fewer",
      });
    }

    const [currentUser, position] = await Promise.all([
      getCurrentUserWithRoles(userId),
      prisma.position.findUnique({
        where: {
          id: positionId,
        },
        include: {
          accessRules: {
            orderBy: {
              sortOrder: "asc",
            },
            include: {
              attribute: true,
            },
          },
        },
      }),
    ]);

    if (!currentUser) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    if (!position) {
      return res.status(404).json({
        message: "Position not found",
      });
    }

    if (!(await canAccessPositionDiscussions(currentUser, position))) {
      return res.status(403).json({
        message: "You do not have access to discussions for this position",
      });
    }

    const post = await prisma.positionDiscussionPost.create({
      data: {
        positionId,
        authorId: userId,
        content: trimmedContent,
      },
      select: {
        id: true,
        content: true,
        createdAt: true,
        author: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    res.status(201).json(post);
  } catch (error) {
    console.error("POST /api/positions/:positionId/discussions error:", error);
    res.status(500).json({
      message: "Failed to create discussion post",
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
        include: getPositionInclude(),
      });

      if (!sourcePosition) {
        return null;
      }

      const duplicatedTitle = await generateDuplicateTitle(
        tx,
        sourcePosition.title,
      );

      return tx.position.create({
        data: {
          title: duplicatedTitle,
          shortDescription: sourcePosition.shortDescription,
          isPublic: sourcePosition.isPublic,
          maxProjects: sourcePosition.maxProjects,
          projectTags: sourcePosition.projectTags || [],
          accessRules: {
            create: (sourcePosition.accessRules || []).map((rule) => ({
              attributeId: rule.attributeId,
              operator: rule.operator,
              stringValue: rule.stringValue,
              numericValue: rule.numericValue,
              booleanValue: rule.booleanValue,
              dateValue: rule.dateValue,
              sortOrder: rule.sortOrder,
            })),
          },
          attributes: {
            create: sourcePosition.attributes.map((item) => ({
              attributeId: item.attributeId,
              isRequired: item.isRequired,
              sortOrder: item.sortOrder,
            })),
          },
        },
        include: getPositionInclude(),
      });
    });

    if (!duplicatedPosition) {
      return res.status(404).json({
        message: "Position not found",
      });
    }

    res.status(201).json(
      serializePosition(duplicatedPosition, {
        includeAccessRules: true,
        isAccessible: true,
      }),
    );
  } catch (error) {
    console.error("POST /api/positions/:id/duplicate error:", error);

    res.status(500).json({
      message: "Failed to duplicate position",
    });
  }
});

router.post("/", async (req, res) => {
  try {
    const userId = getDevUserId(req);
    const {
      title,
      shortDescription,
      isPublic = true,
      maxProjects = 3,
      projectTags = [],
      attributes = [],
      accessRules = [],
    } = req.body;

    if (!userId) {
      return res
        .status(401)
        .json({ message: "Dev user id header is required" });
    }

    const currentUser = await getCurrentUserWithRoles(userId);

    if (!currentUser) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    if (!canManagePositions(currentUser)) {
      return res.status(403).json({
        message: "Only recruiters/admins can create positions",
      });
    }

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

    const { normalizedRules, error: accessRulesError } =
      await getNormalizedAccessRulesOrError(accessRules);

    if (accessRulesError) {
      return res.status(400).json({
        message: accessRulesError,
      });
    }

    const position = await prisma.position.create({
      data: {
        title,
        shortDescription: shortDescription || null,
        isPublic,
        maxProjects: Number(maxProjects) || 3,
        projectTags: sanitizedProjectTags,
        accessRules: {
          create: normalizedRules,
        },
        attributes: {
          create: attributes.map((item, index) => ({
            attributeId: item.attributeId,
            isRequired: Boolean(item.isRequired),
            sortOrder: Number.isInteger(item.sortOrder)
              ? item.sortOrder
              : index + 1,
          })),
        },
      },
      include: getPositionInclude(),
    });

    res.status(201).json(
      serializePosition(position, {
        includeAccessRules: true,
        isAccessible: true,
      }),
    );
  } catch (error) {
    console.error("POST /api/positions error:", error);

    res.status(500).json({
      message: "Failed to create position",
    });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const userId = getDevUserId(req);
    const id = Number(req.params.id);
    const {
      title,
      shortDescription,
      isPublic = true,
      maxProjects = 3,
      projectTags = [],
      version,
      attributes = [],
      accessRules = [],
    } = req.body;

    if (!userId) {
      return res
        .status(401)
        .json({ message: "Dev user id header is required" });
    }

    const currentUser = await getCurrentUserWithRoles(userId);

    if (!currentUser) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    if (!canManagePositions(currentUser)) {
      return res.status(403).json({
        message: "Only recruiters/admins can update positions",
      });
    }

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

    const { normalizedRules, error: accessRulesError } =
      await getNormalizedAccessRulesOrError(accessRules);

    if (accessRulesError) {
      return res.status(400).json({
        message: accessRulesError,
      });
    }

    const updateResult = await prisma.$transaction(async (tx) => {
      const updated = await tx.position.updateMany({
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

      if (updated.count === 0) {
        return updated;
      }

      await tx.positionAttribute.deleteMany({
        where: { positionId: id },
      });

      if (attributes.length > 0) {
        await tx.positionAttribute.createMany({
          data: attributes.map((item, index) => ({
            positionId: id,
            attributeId: item.attributeId,
            isRequired: Boolean(item.isRequired),
            sortOrder: Number.isInteger(item.sortOrder)
              ? item.sortOrder
              : index + 1,
          })),
        });
      }

      await tx.positionAccessRule.deleteMany({
        where: {
          positionId: id,
        },
      });

      if (normalizedRules.length > 0) {
        await tx.positionAccessRule.createMany({
          data: normalizedRules.map((rule, index) => ({
            positionId: id,
            attributeId: rule.attributeId,
            operator: rule.operator,
            stringValue: rule.stringValue,
            numericValue: rule.numericValue,
            booleanValue: rule.booleanValue,
            dateValue: rule.dateValue,
            sortOrder: Number.isInteger(rule.sortOrder)
              ? rule.sortOrder
              : index + 1,
          })),
        });
      }

      return updated;
    });

    if (updateResult.count === 0) {
      return res.status(409).json({
        message:
          "Position was changed by someone else. Please reload and try again.",
      });
    }

    const updatedPosition = await prisma.position.findUnique({
      where: { id },
      include: getPositionInclude(),
    });

    res.json(
      serializePosition(updatedPosition, {
        includeAccessRules: true,
        isAccessible: true,
      }),
    );
  } catch (error) {
    console.error("PUT /api/positions/:id error:", error);

    res.status(500).json({
      message: "Failed to update position",
    });
  }
});

router.delete("/", async (req, res) => {
  try {
    const userId = getDevUserId(req);
    const { ids } = req.body;

    if (!userId) {
      return res
        .status(401)
        .json({ message: "Dev user id header is required" });
    }

    const currentUser = await getCurrentUserWithRoles(userId);

    if (!currentUser) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    if (!canManagePositions(currentUser)) {
      return res.status(403).json({
        message: "Only recruiters/admins can delete positions",
      });
    }

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
