const express = require("express");
const prisma = require("../lib/prisma");
const {
  buildCandidatePositionAccessMap,
  canCandidateAccessPosition,
} = require("../utils/positionAccess");

const router = express.Router();

function getDevUserId(req) {
  return req.header("x-dev-user-id") || null;
}

function isAttributeValueMissing(attributeType, value) {
  if (!value) {
    return true;
  }

  if (attributeType === "STRING" || attributeType === "SELECT") {
    return value.stringValue === null || value.stringValue === "";
  }

  if (attributeType === "TEXT") {
    return value.textValue === null || value.textValue === "";
  }

  if (attributeType === "NUMERIC") {
    return value.numericValue === null;
  }

  if (attributeType === "BOOLEAN") {
    return value.booleanValue === null;
  }

  if (attributeType === "DATE") {
    return value.dateValue === null;
  }

  if (attributeType === "PERIOD") {
    return value.periodStart === null || value.periodEnd === null;
  }

  if (attributeType === "IMAGE") {
    return value.imageUrl === null || value.imageUrl === "";
  }

  return true;
}

async function getCvWithPositionAttributes(cvId) {
  return prisma.cv.findUnique({
    where: {
      id: cvId,
    },
    include: {
      position: {
        include: {
          accessRules: {
            orderBy: {
              sortOrder: "asc",
            },
            include: {
              attribute: true,
            },
          },
          attributes: {
            orderBy: {
              sortOrder: "asc",
            },
            include: {
              attribute: true,
            },
          },
        },
      },
    },
  });
}

async function getProfileValuesByAttributeId(userId, positionAttributes) {
  const attributeIds = positionAttributes.map((item) => item.attributeId);

  if (attributeIds.length === 0) {
    return new Map();
  }

  const profileValues = await prisma.profileAttributeValue.findMany({
    where: {
      userId,
      attributeId: {
        in: attributeIds,
      },
    },
  });

  return new Map(profileValues.map((value) => [value.attributeId, value]));
}

async function getProjectsForCvOwner(userId, maxProjects) {
  const take =
    Number.isInteger(maxProjects) && maxProjects > 0 ? maxProjects : 3;

  return prisma.project.findMany({
    where: {
      userId,
    },
    orderBy: {
      updatedAt: "desc",
    },
    take,
    select: {
      id: true,
      name: true,
      description: true,
      periodStart: true,
      periodEnd: true,
      technologyTags: true,
      version: true,
      updatedAt: true,
    },
  });
}

async function getFilteredProjectsForCvOwner(userId, position) {
  const take =
    Number.isInteger(position?.maxProjects) && position.maxProjects > 0
      ? position.maxProjects
      : 3;

  const projects = await prisma.project.findMany({
    where: {
      userId,
    },
    orderBy: {
      updatedAt: "desc",
    },
    select: {
      id: true,
      name: true,
      description: true,
      periodStart: true,
      periodEnd: true,
      technologyTags: true,
      version: true,
      updatedAt: true,
    },
  });

  const positionProjectTags = Array.isArray(position?.projectTags)
    ? position.projectTags.filter(Boolean)
    : [];

  if (positionProjectTags.length === 0) {
    return projects.slice(0, take);
  }

  const positionTagSet = new Set(positionProjectTags);

  return projects
    .filter((project) =>
      (project.technologyTags || []).some((tag) => positionTagSet.has(tag)),
    )
    .slice(0, take);
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
  return user.roles.map((userRole) => userRole.role.name);
}

function canLikeCv(user) {
  const roleNames = getRoleNames(user);

  return roleNames.includes("RECRUITER") || roleNames.includes("ADMIN");
}

function isCandidateOnly(user) {
  const roleNames = getRoleNames(user);

  return (
    roleNames.includes("CANDIDATE") &&
    !roleNames.includes("RECRUITER") &&
    !roleNames.includes("ADMIN")
  );
}

async function getCvLikesMeta(cvId, currentUserId, includeLikedByCurrentUser = false) {
  const queries = [
    prisma.cvLike.count({
      where: {
        cvId,
      },
    }),
  ];

  if (includeLikedByCurrentUser && currentUserId) {
    queries.push(
      prisma.cvLike.findFirst({
        where: {
          cvId,
          userId: currentUserId,
        },
        select: {
          id: true,
        },
      }),
    );
  }

  const [likesCount, currentLike] = await prisma.$transaction(queries);

  return {
    likesCount,
    likedByCurrentUser: includeLikedByCurrentUser ? Boolean(currentLike) : false,
  };
}

router.get("/my", async (req, res) => {
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

    const cvs = await prisma.cv.findMany({
      where: {
        userId,
      },
      orderBy: {
        updatedAt: "desc",
      },
      include: {
        position: {
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
        },
        _count: {
          select: {
            likes: true,
          },
        },
      },
    });

    const accessibleCvs = isCandidateOnly(currentUser)
      ? (() => {
          const positions = cvs
            .map((cv) => cv.position)
            .filter(Boolean);

          return buildCandidatePositionAccessMap(userId, positions).then(
            (candidateAccessMap) =>
              cvs.filter((cv) => candidateAccessMap.get(cv.positionId)?.accessible),
          );
        })()
      : Promise.resolve(cvs);

    res.json(
      (await accessibleCvs).map(({ _count, position, ...cv }) => ({
        ...cv,
        position: position
          ? {
              ...position,
              accessRules: undefined,
            }
          : null,
        likesCount: _count.likes,
      })),
    );
  } catch (error) {
    console.error("GET /api/cvs/my error:", error);
    res.status(500).json({
      message: "Failed to load CVs",
    });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const userId = getDevUserId(req);
    const cvId = Number(req.params.id);

    if (!userId) {
      return res
        .status(401)
        .json({ message: "Dev user id header is required" });
    }

    if (!Number.isInteger(cvId)) {
      return res.status(404).json({
        message: "CV not found",
      });
    }

    const currentUser = await getCurrentUserWithRoles(userId);

    if (!currentUser) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    const cv = await getCvWithPositionAttributes(cvId);

    if (!cv) {
      return res.status(404).json({
        message: "CV not found",
      });
    }

    const roleNames = getRoleNames(currentUser);
    const isAdmin = roleNames.includes("ADMIN");
    const isRecruiter = roleNames.includes("RECRUITER");
    const isCandidate = roleNames.includes("CANDIDATE");
    const isOwner = cv.userId === userId;

    if (isCandidate && isOwner) {
      const accessResult = await canCandidateAccessPosition(userId, cv.position);

      if (!accessResult.accessible) {
        return res.status(403).json({
          message: "This CV is hidden because you no longer have access to the position.",
        });
      }
    }

    const canAccess =
      (isCandidate && isOwner) || isAdmin || (isRecruiter && cv.status === "PUBLISHED");

    if (!canAccess) {
      return res.status(403).json({
        message: "You do not have access to this CV",
      });
    }

    const profileValuesByAttributeId = await getProfileValuesByAttributeId(
      cv.userId,
      cv.position.attributes,
    );
    const projects = await getFilteredProjectsForCvOwner(cv.userId, cv.position);
    const likesMeta = await getCvLikesMeta(
      cv.id,
      userId,
      canLikeCv(currentUser) && cv.status === "PUBLISHED",
    );

    const viewerRole = isOwner && isCandidate
      ? "CANDIDATE"
      : isAdmin
        ? "ADMIN"
        : "RECRUITER";

    const response = {
      id: cv.id,
      status: cv.status,
      version: cv.version,
      createdAt: cv.createdAt,
      updatedAt: cv.updatedAt,
      viewerRole,
      canEditValues: viewerRole === "CANDIDATE",
      likesCount: likesMeta.likesCount,
      likedByCurrentUser: likesMeta.likedByCurrentUser,
      position: {
        id: cv.position.id,
        title: cv.position.title,
        shortDescription: cv.position.shortDescription,
        maxProjects: cv.position.maxProjects,
        projectTags: cv.position.projectTags,
      },
      projects,
      attributes: cv.position.attributes.map((item) => {
        const value = profileValuesByAttributeId.get(item.attributeId) || null;

        return {
          positionAttributeId: item.id,
          attributeId: item.attribute.id,
          name: item.attribute.name,
          category: item.attribute.category,
          type: item.attribute.type,
          description: item.attribute.description,
          isRequired: item.isRequired,
          sortOrder: item.sortOrder,
          value: value
            ? {
                id: value.id,
                stringValue: value.stringValue,
                textValue: value.textValue,
                numericValue: value.numericValue,
                booleanValue: value.booleanValue,
                dateValue: value.dateValue,
                periodStart: value.periodStart,
                periodEnd: value.periodEnd,
                imageUrl: value.imageUrl,
                version: value.version,
              }
            : {
                id: null,
                stringValue: null,
                textValue: null,
                numericValue: null,
                booleanValue: null,
                dateValue: null,
                periodStart: null,
                periodEnd: null,
                imageUrl: null,
                version: null,
              },
          isMissing: isAttributeValueMissing(item.attribute.type, value),
        };
      }),
    };

    res.json(response);
  } catch (error) {
    console.error("GET /api/cvs/:id error:", error);
    res.status(500).json({
      message: "Failed to load CV preview data",
    });
  }
});

router.post("/:id/like", async (req, res) => {
  try {
    const userId = getDevUserId(req);
    const cvId = Number(req.params.id);

    if (!userId) {
      return res
        .status(401)
        .json({ message: "Dev user id header is required" });
    }

    if (!Number.isInteger(cvId)) {
      return res.status(404).json({
        message: "CV not found",
      });
    }

    const currentUser = await getCurrentUserWithRoles(userId);

    if (!currentUser) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    if (!canLikeCv(currentUser)) {
      return res.status(403).json({
        message: "Only recruiters/admins can like CVs",
      });
    }

    const cv = await prisma.cv.findUnique({
      where: {
        id: cvId,
      },
      select: {
        id: true,
        status: true,
      },
    });

    if (!cv) {
      return res.status(404).json({
        message: "CV not found",
      });
    }

    if (cv.status !== "PUBLISHED") {
      return res.status(403).json({
        message: "Only published CVs can be liked",
      });
    }

    const existingLike = await prisma.cvLike.findFirst({
      where: {
        cvId,
        userId,
      },
      select: {
        id: true,
      },
    });

    if (!existingLike) {
      await prisma.cvLike.create({
        data: {
          cvId,
          userId,
        },
      });
    }

    const likesCount = await prisma.cvLike.count({
      where: {
        cvId,
      },
    });

    res.json({
      cvId,
      liked: true,
      likesCount,
    });
  } catch (error) {
    console.error("POST /api/cvs/:id/like error:", error);
    res.status(500).json({
      message: "Failed to like CV",
    });
  }
});

router.delete("/:id/like", async (req, res) => {
  try {
    const userId = getDevUserId(req);
    const cvId = Number(req.params.id);

    if (!userId) {
      return res
        .status(401)
        .json({ message: "Dev user id header is required" });
    }

    if (!Number.isInteger(cvId)) {
      return res.status(404).json({
        message: "CV not found",
      });
    }

    const currentUser = await getCurrentUserWithRoles(userId);

    if (!currentUser) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    if (!canLikeCv(currentUser)) {
      return res.status(403).json({
        message: "Only recruiters/admins can unlike CVs",
      });
    }

    const cv = await prisma.cv.findUnique({
      where: {
        id: cvId,
      },
      select: {
        id: true,
        status: true,
      },
    });

    if (!cv) {
      return res.status(404).json({
        message: "CV not found",
      });
    }

    if (cv.status !== "PUBLISHED") {
      return res.status(403).json({
        message: "Only published CVs can be unliked",
      });
    }

    await prisma.cvLike.deleteMany({
      where: {
        cvId,
        userId,
      },
    });

    const likesCount = await prisma.cvLike.count({
      where: {
        cvId,
      },
    });

    res.json({
      cvId,
      liked: false,
      likesCount,
    });
  } catch (error) {
    console.error("DELETE /api/cvs/:id/like error:", error);
    res.status(500).json({
      message: "Failed to unlike CV",
    });
  }
});

router.patch("/:id/publish", async (req, res) => {
  try {
    const userId = getDevUserId(req);
    const cvId = Number(req.params.id);
    const { version } = req.body;

    if (!userId) {
      return res
        .status(401)
        .json({ message: "Dev user id header is required" });
    }

    if (!Number.isInteger(cvId)) {
      return res.status(404).json({
        message: "CV not found",
      });
    }

    if (typeof version !== "number") {
      return res.status(400).json({
        message: "Version is required",
      });
    }

    const cv = await getCvWithPositionAttributes(cvId);

    if (!cv) {
      return res.status(404).json({
        message: "CV not found",
      });
    }

    if (cv.userId !== userId) {
      return res.status(403).json({
        message: "You do not have access to this CV",
      });
    }

    if (cv.version !== version) {
      return res.status(409).json({
        message: "CV was changed elsewhere. Please reload and try again.",
      });
    }

    if (cv.status === "PUBLISHED") {
      return res.json({
        message: "CV is already published",
        cv,
      });
    }

    const profileValuesByAttributeId = await getProfileValuesByAttributeId(
      userId,
      cv.position.attributes,
    );

    const missingAttributes = cv.position.attributes
      .filter((item) =>
        isAttributeValueMissing(
          item.attribute.type,
          profileValuesByAttributeId.get(item.attributeId) || null,
        ),
      )
      .map((item) => ({
        attributeId: item.attribute.id,
        name: item.attribute.name,
        type: item.attribute.type,
        isRequired: item.isRequired,
      }));

    if (missingAttributes.length > 0) {
      return res.status(400).json({
        message: "Cannot publish CV while some attributes are missing",
        missingAttributes,
      });
    }

    const updatedCv = await prisma.cv.update({
      where: {
        id: cv.id,
      },
      data: {
        status: "PUBLISHED",
        version: {
          increment: 1,
        },
      },
      include: {
        position: true,
      },
    });

    res.json(updatedCv);
  } catch (error) {
    console.error("PATCH /api/cvs/:id/publish error:", error);
    res.status(500).json({
      message: "Failed to publish CV",
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
    });

    if (!position) {
      return res.status(404).json({
        message: "Position not found",
      });
    }

    const currentUser = await getCurrentUserWithRoles(userId);

    if (!currentUser) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    if (isCandidateOnly(currentUser)) {
      const accessResult = await canCandidateAccessPosition(userId, position);

      if (!accessResult.accessible) {
        return res.status(403).json({
          message: "You do not have access to this position.",
        });
      }
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
