const express = require("express");
const prisma = require("../lib/prisma");

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
      return res.status(401).json({
        message: "Current user not found",
      });
    }

    const cv = await getCvWithPositionAttributes(cvId);

    if (!cv) {
      return res.status(404).json({
        message: "CV not found",
      });
    }

    const roleNames = currentUser.roles.map((userRole) => userRole.role.name);
    const isAdmin = roleNames.includes("ADMIN");
    const isRecruiter = roleNames.includes("RECRUITER");
    const isCandidate = roleNames.includes("CANDIDATE");
    const isOwner = cv.userId === userId;

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
      position: {
        id: cv.position.id,
        title: cv.position.title,
        shortDescription: cv.position.shortDescription,
        maxProjects: cv.position.maxProjects,
      },
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
