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

function buildTechnologyTagCloud(positions) {
  const tagsMap = new Map();

  positions.forEach((position) => {
    const uniqueTags = new Set(
      (position.projectTags || [])
        .map((tag) => tag.trim())
        .filter(Boolean),
    );

    uniqueTags.forEach((tag) => {
      const normalizedTag = tag.toLowerCase();
      const existing = tagsMap.get(normalizedTag);

      if (existing) {
        existing.count += 1;
        return;
      }

      tagsMap.set(normalizedTag, {
        tag,
        count: 1,
      });
    });
  });

  return [...tagsMap.values()]
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }

      return left.tag.localeCompare(right.tag);
    })
    .slice(0, 15);
}

async function getPositionDashboardSections(positionWhere) {
  const publicOnly = positionWhere?.isPublic === true;
  const positions = await prisma.$queryRaw`
    SELECT
      p.id,
      p.title,
      p."shortDescription",
      p."projectTags",
      p."updatedAt",
      COUNT(cv.id)::integer AS "submittedCvsCount",
      COUNT(cv.id) FILTER (WHERE cv.status = 'PUBLISHED')::integer
        AS "publishedCvsCount"
    FROM "Position" p
    LEFT JOIN "Cv" cv ON cv."positionId" = p.id
    WHERE ${publicOnly}::boolean = false OR p."isPublic" = true
    GROUP BY p.id
  `;

  if (positions.length === 0) {
    return {
      popularPositions: [],
      technologyTagCloud: [],
    };
  }

  const positionsWithCounts = positions.map((position) => ({
    id: position.id,
    title: position.title,
    shortDescription: position.shortDescription,
    projectTags: position.projectTags,
    updatedAt: position.updatedAt,
    submittedCvsCount: position.submittedCvsCount,
    publishedCvsCount: position.publishedCvsCount,
  }));

  const hasAnySubmittedCvs = positionsWithCounts.some(
    (position) => position.submittedCvsCount > 0,
  );

  const sortedPositions = hasAnySubmittedCvs
    ? positionsWithCounts.sort((left, right) => {
        if (right.submittedCvsCount !== left.submittedCvsCount) {
          return right.submittedCvsCount - left.submittedCvsCount;
        }

        return left.title.localeCompare(right.title);
      })
    : positionsWithCounts.sort(
        (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime(),
      );

  return {
    popularPositions: sortedPositions
      .slice(0, 5)
      .map(({ updatedAt, projectTags, ...position }) => position),
    technologyTagCloud: buildTechnologyTagCloud(positions),
  };
}

async function getCandidateStats(userId) {
  const [stats] = await prisma.$queryRaw`
    SELECT
      (SELECT COUNT(*)::integer FROM "Cv" WHERE "userId" = ${userId})
        AS "totalCvs",
      (SELECT COUNT(*)::integer FROM "Cv"
        WHERE "userId" = ${userId} AND status = 'PUBLISHED')
        AS "publishedCvs",
      (SELECT COUNT(*)::integer FROM "Cv"
        WHERE "userId" = ${userId} AND status = 'DRAFT')
        AS "draftCvs",
      (SELECT COUNT(*)::integer FROM "Project" WHERE "userId" = ${userId})
        AS projects,
      (SELECT COUNT(*)::integer FROM "Attribute") AS "totalAttributes",
      (
        SELECT COUNT(*)::integer
        FROM "ProfileAttributeValue"
        WHERE "userId" = ${userId}
          AND (
            ("stringValue" IS NOT NULL AND "stringValue" <> '')
            OR ("textValue" IS NOT NULL AND "textValue" <> '')
            OR "numericValue" IS NOT NULL
            OR "booleanValue" IS NOT NULL
            OR "dateValue" IS NOT NULL
            OR "periodStart" IS NOT NULL
            OR "periodEnd" IS NOT NULL
            OR ("imageUrl" IS NOT NULL AND "imageUrl" <> '')
          )
      ) AS "filledProfileAttributes"
  `;

  return stats;
}

async function getRecruiterStats() {
  const [stats] = await prisma.$queryRaw`
    SELECT
      (SELECT COUNT(*)::integer FROM "Position") AS positions,
      (SELECT COUNT(*)::integer FROM "Attribute") AS attributes,
      (SELECT COUNT(*)::integer FROM "Cv" WHERE status = 'PUBLISHED')
        AS "publishedCvs",
      (
        SELECT COUNT(DISTINCT "userId")::integer
        FROM "Cv"
        WHERE status = 'PUBLISHED'
      ) AS "candidatesWithPublishedCvs",
      (SELECT COUNT(*)::integer FROM "Position" WHERE "isPublic" = true)
        AS "publicPositions"
  `;

  return stats;
}

async function buildCandidateDashboard(userId) {
  const [
    stats,
    recentCvs,
    recentProjects,
    positionSections,
  ] = await Promise.all([
    getCandidateStats(userId),
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
    getPositionDashboardSections({
      isPublic: true,
    }),
  ]);

  return {
    role: "CANDIDATE",
    stats: {
      totalCvs: stats.totalCvs,
      publishedCvs: stats.publishedCvs,
      draftCvs: stats.draftCvs,
      projects: stats.projects,
      filledProfileAttributes: stats.filledProfileAttributes,
      totalAttributes: stats.totalAttributes,
      missingProfileAttributes: Math.max(
        stats.totalAttributes - stats.filledProfileAttributes,
        0,
      ),
    },
    recentCvs,
    recentProjects,
    popularPositions: positionSections.popularPositions,
    technologyTagCloud: positionSections.technologyTagCloud,
  };
}

async function buildRecruiterDashboard(role) {
  const [
    stats,
    recentPublishedCvs,
    recentPositions,
    positionSections,
  ] = await Promise.all([
    getRecruiterStats(),
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
    getPositionDashboardSections(),
  ]);

  return {
    role,
    stats: {
      positions: stats.positions,
      attributes: stats.attributes,
      publishedCvs: stats.publishedCvs,
      candidatesWithPublishedCvs: stats.candidatesWithPublishedCvs,
      publicPositions: stats.publicPositions,
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
    popularPositions: positionSections.popularPositions,
    technologyTagCloud: positionSections.technologyTagCloud,
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
