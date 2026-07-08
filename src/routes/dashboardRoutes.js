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

function getViewerRole(user) {
  const roleNames = user.roles.map((userRole) => userRole.role.name);

  if (roleNames.includes("ADMIN")) {
    return "ADMIN";
  }

  if (roleNames.includes("RECRUITER")) {
    return "RECRUITER";
  }

  if (roleNames.includes("CANDIDATE")) {
    return "CANDIDATE";
  }

  return null;
}

function getFilledProfileAttributesWhere(userId) {
  return {
    userId,
    OR: [
      {
        AND: [
          {
            stringValue: {
              not: null,
            },
          },
          {
            stringValue: {
              not: "",
            },
          },
        ],
      },
      {
        AND: [
          {
            textValue: {
              not: null,
            },
          },
          {
            textValue: {
              not: "",
            },
          },
        ],
      },
      {
        numericValue: {
          not: null,
        },
      },
      {
        booleanValue: {
          not: null,
        },
      },
      {
        dateValue: {
          not: null,
        },
      },
      {
        periodStart: {
          not: null,
        },
      },
      {
        periodEnd: {
          not: null,
        },
      },
      {
        AND: [
          {
            imageUrl: {
              not: null,
            },
          },
          {
            imageUrl: {
              not: "",
            },
          },
        ],
      },
    ],
  };
}

async function buildCandidateDashboard(userId) {
  const [
    totalCvs,
    publishedCvs,
    draftCvs,
    projects,
    totalAttributes,
    filledProfileAttributes,
    recentCvs,
    recentProjects,
  ] = await Promise.all([
    prisma.cv.count({
      where: { userId },
    }),
    prisma.cv.count({
      where: {
        userId,
        status: "PUBLISHED",
      },
    }),
    prisma.cv.count({
      where: {
        userId,
        status: "DRAFT",
      },
    }),
    prisma.project.count({
      where: { userId },
    }),
    prisma.attribute.count(),
    prisma.profileAttributeValue.count({
      where: getFilledProfileAttributesWhere(userId),
    }),
    prisma.cv.findMany({
      where: { userId },
      orderBy: {
        updatedAt: "desc",
      },
      take: 5,
      select: {
        id: true,
        status: true,
        version: true,
        createdAt: true,
        updatedAt: true,
        position: {
          select: {
            id: true,
            title: true,
          },
        },
      },
    }),
    prisma.project.findMany({
      where: { userId },
      orderBy: {
        updatedAt: "desc",
      },
      take: 5,
      select: {
        id: true,
        name: true,
        technologyTags: true,
        createdAt: true,
        updatedAt: true,
        version: true,
      },
    }),
  ]);

  return {
    role: "CANDIDATE",
    stats: {
      totalCvs,
      publishedCvs,
      draftCvs,
      projects,
      filledProfileAttributes,
      totalAttributes,
      missingProfileAttributes: Math.max(
        totalAttributes - filledProfileAttributes,
        0,
      ),
    },
    recentCvs,
    recentProjects,
  };
}

async function buildRecruiterDashboard(role) {
  const [
    positions,
    attributes,
    publishedCvs,
    publicPositions,
    candidatesWithPublishedCvsGroups,
    recentPublishedCvs,
    recentPositions,
  ] = await Promise.all([
    prisma.position.count(),
    prisma.attribute.count(),
    prisma.cv.count({
      where: {
        status: "PUBLISHED",
      },
    }),
    prisma.position.count({
      where: {
        isPublic: true,
      },
    }),
    prisma.cv.groupBy({
      by: ["userId"],
      where: {
        status: "PUBLISHED",
      },
    }),
    prisma.cv.findMany({
      where: {
        status: "PUBLISHED",
      },
      orderBy: {
        updatedAt: "desc",
      },
      take: 5,
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
        position: {
          select: {
            id: true,
            title: true,
          },
        },
      },
    }),
    prisma.position.findMany({
      orderBy: {
        updatedAt: "desc",
      },
      take: 5,
      select: {
        id: true,
        title: true,
        shortDescription: true,
        isPublic: true,
        version: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);

  return {
    role,
    stats: {
      positions,
      attributes,
      publishedCvs,
      candidatesWithPublishedCvs: candidatesWithPublishedCvsGroups.length,
      publicPositions,
    },
    recentPublishedCvs: recentPublishedCvs.map((cv) => ({
      id: cv.id,
      status: cv.status,
      version: cv.version,
      createdAt: cv.createdAt,
      updatedAt: cv.updatedAt,
      candidate: cv.user,
      position: cv.position,
    })),
    recentPositions,
  };
}

router.get("/stats", async (req, res) => {
  try {
    const userId = getDevUserId(req);

    if (!userId) {
      return res.status(401).json({
        message: "Dev user id header is required",
      });
    }

    const currentUser = await getCurrentUserWithRoles(userId);

    if (!currentUser) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    const viewerRole = getViewerRole(currentUser);

    if (!viewerRole) {
      return res.status(403).json({
        message: "You do not have access to dashboard statistics",
      });
    }

    const response =
      viewerRole === "CANDIDATE"
        ? await buildCandidateDashboard(currentUser.id)
        : await buildRecruiterDashboard(viewerRole);

    res.json(response);
  } catch (error) {
    console.error("GET /api/dashboard/stats error:", error);
    res.status(500).json({
      message: "Failed to load dashboard statistics",
    });
  }
});

module.exports = router;
