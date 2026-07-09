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

function getEmptyResults(role) {
  if (role === "CANDIDATE") {
    return {
      positions: [],
      cvs: [],
      projects: [],
      profileValues: [],
    };
  }

  return {
    positions: [],
    attributes: [],
    publishedCvs: [],
    candidates: [],
  };
}

function buildEmptyResponse(query, role) {
  return {
    query,
    role,
    totalCount: 0,
    results: getEmptyResults(role),
  };
}

function includesQuery(value, query) {
  if (typeof value !== "string") {
    return false;
  }

  return value.toLowerCase().includes(query);
}

function matchesAnyTag(tags, query) {
  if (!Array.isArray(tags)) {
    return false;
  }

  return tags.some((tag) => includesQuery(tag, query));
}

async function searchCandidate(userId, query) {
  const statusQuery =
    query === "draft" || query === "published" ? query.toUpperCase() : null;
  const [
    positionsFromDatabase,
    cvs,
    projectsFromDatabase,
    profileValues,
  ] = await Promise.all([
    prisma.position.findMany({
      where: {
        isPublic: true,
      },
      orderBy: {
        updatedAt: "desc",
      },
      take: 50,
      select: {
        id: true,
        title: true,
        shortDescription: true,
        isPublic: true,
        projectTags: true,
        updatedAt: true,
      },
    }),
    prisma.cv.findMany({
      where: {
        userId,
        OR: [
          ...(statusQuery
            ? [
                {
                  status: statusQuery,
                },
              ]
            : []),
          {
            position: {
              title: {
                contains: query,
                mode: "insensitive",
              },
            },
          },
        ],
      },
      orderBy: {
        updatedAt: "desc",
      },
      take: 5,
      select: {
        id: true,
        status: true,
        updatedAt: true,
        position: {
          select: {
            title: true,
          },
        },
      },
    }),
    prisma.project.findMany({
      where: {
        userId,
      },
      orderBy: {
        updatedAt: "desc",
      },
      take: 50,
      select: {
        id: true,
        name: true,
        description: true,
        technologyTags: true,
        updatedAt: true,
      },
    }),
    prisma.profileAttributeValue.findMany({
      where: {
        userId,
        OR: [
          {
            stringValue: {
              contains: query,
              mode: "insensitive",
            },
          },
          {
            textValue: {
              contains: query,
              mode: "insensitive",
            },
          },
          {
            attribute: {
              name: {
                contains: query,
                mode: "insensitive",
              },
            },
          },
        ],
      },
      orderBy: {
        updatedAt: "desc",
      },
      take: 5,
      select: {
        id: true,
        stringValue: true,
        textValue: true,
        updatedAt: true,
        attribute: {
          select: {
            id: true,
            name: true,
            type: true,
          },
        },
      },
    }),
  ]);

  const positions = positionsFromDatabase
    .filter(
      (position) =>
        includesQuery(position.title, query) ||
        includesQuery(position.shortDescription, query) ||
        matchesAnyTag(position.projectTags, query),
    )
    .slice(0, 10)
    .map(({ projectTags, updatedAt, ...position }) => ({
      ...position,
      type: "position",
    }));

  const projects = projectsFromDatabase
    .filter(
      (project) =>
        includesQuery(project.name, query) ||
        includesQuery(project.description, query) ||
        matchesAnyTag(project.technologyTags, query),
    )
    .slice(0, 10)
    .map((project) => ({
      id: project.id,
      name: project.name,
      description: project.description,
      technologyTags: project.technologyTags,
      updatedAt: project.updatedAt,
      type: "project",
    }));

  return {
    positions,
    cvs: cvs.map((cv) => ({
      id: cv.id,
      status: cv.status,
      positionTitle: cv.position?.title || "—",
      updatedAt: cv.updatedAt,
      type: "cv",
    })),
    projects,
    profileValues: profileValues.map((value) => ({
      id: value.id,
      attributeId: value.attribute.id,
      attributeName: value.attribute.name,
      attributeType: value.attribute.type,
      value: value.stringValue || value.textValue || "—",
      updatedAt: value.updatedAt,
      type: "profileValue",
    })),
  };
}

async function searchRecruiter(query) {
  const [
    positionsFromDatabase,
    attributes,
    publishedCvs,
    candidates,
  ] = await Promise.all([
    prisma.position.findMany({
      orderBy: {
        updatedAt: "desc",
      },
      take: 100,
      select: {
        id: true,
        title: true,
        shortDescription: true,
        isPublic: true,
        projectTags: true,
      },
    }),
    prisma.attribute.findMany({
      where: {
        OR: [
          {
            name: {
              contains: query,
              mode: "insensitive",
            },
          },
          {
            description: {
              contains: query,
              mode: "insensitive",
            },
          },
        ],
      },
      orderBy: {
        updatedAt: "desc",
      },
      take: 10,
      select: {
        id: true,
        name: true,
        category: true,
        type: true,
        description: true,
      },
    }),
    prisma.cv.findMany({
      where: {
        status: "PUBLISHED",
        OR: [
          {
            position: {
              title: {
                contains: query,
                mode: "insensitive",
              },
            },
          },
          {
            user: {
              name: {
                contains: query,
                mode: "insensitive",
              },
            },
          },
          {
            user: {
              email: {
                contains: query,
                mode: "insensitive",
              },
            },
          },
        ],
      },
      orderBy: {
        updatedAt: "desc",
      },
      take: 10,
      select: {
        id: true,
        status: true,
        updatedAt: true,
        position: {
          select: {
            title: true,
          },
        },
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    }),
    prisma.user.findMany({
      where: {
        roles: {
          some: {
            role: {
              name: "CANDIDATE",
            },
          },
        },
        cvs: {
          some: {
            status: "PUBLISHED",
          },
        },
        OR: [
          {
            name: {
              contains: query,
              mode: "insensitive",
            },
          },
          {
            email: {
              contains: query,
              mode: "insensitive",
            },
          },
        ],
      },
      orderBy: {
        updatedAt: "desc",
      },
      take: 10,
      select: {
        id: true,
        name: true,
        email: true,
      },
    }),
  ]);

  const positions = positionsFromDatabase
    .filter(
      (position) =>
        includesQuery(position.title, query) ||
        includesQuery(position.shortDescription, query) ||
        matchesAnyTag(position.projectTags, query),
    )
    .slice(0, 10)
    .map((position) => ({
      id: position.id,
      title: position.title,
      shortDescription: position.shortDescription,
      isPublic: position.isPublic,
      type: "position",
    }));

  return {
    positions,
    attributes: attributes.map((attribute) => ({
      ...attribute,
      type: "attribute",
    })),
    publishedCvs: publishedCvs.map((cv) => ({
      id: cv.id,
      status: cv.status,
      positionTitle: cv.position?.title || "—",
      candidateName: cv.user?.name || "—",
      candidateEmail: cv.user?.email || "—",
      updatedAt: cv.updatedAt,
      type: "publishedCv",
    })),
    candidates: candidates.map((candidate) => ({
      ...candidate,
      type: "candidate",
    })),
  };
}

router.get("/", async (req, res) => {
  try {
    const userId = getDevUserId(req);

    if (!userId) {
      return res.status(401).json({
        message: "Dev user id header is required",
      });
    }

    if (typeof req.query.q !== "string") {
      return res.status(400).json({
        message: "Query parameter q is required",
      });
    }

    const trimmedQuery = req.query.q.trim().slice(0, 100);
    const currentUser = await getCurrentUserWithRoles(userId);

    if (!currentUser) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    const viewerRole = getViewerRole(currentUser);

    if (!viewerRole) {
      return res.status(403).json({
        message: "You do not have access to search",
      });
    }

    if (trimmedQuery.length < 2) {
      return res.json(buildEmptyResponse(trimmedQuery, viewerRole));
    }

    const normalizedQuery = trimmedQuery.toLowerCase();
    const results =
      viewerRole === "CANDIDATE"
        ? await searchCandidate(currentUser.id, normalizedQuery)
        : await searchRecruiter(normalizedQuery);

    const totalCount = Object.values(results).reduce(
      (sum, items) => sum + items.length,
      0,
    );

    res.json({
      query: trimmedQuery,
      role: viewerRole,
      totalCount,
      results,
    });
  } catch (error) {
    console.error("GET /api/search error:", error);
    res.status(500).json({
      message: "Failed to search",
    });
  }
});

module.exports = router;
