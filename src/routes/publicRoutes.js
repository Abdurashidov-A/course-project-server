const express = require("express");
const { Prisma } = require("@prisma/client");
const prisma = require("../lib/prisma");
const { normalizeSearchQuery, runFullTextQuery } = require("../utils/fullTextSearch");

const router = express.Router();

const POSITION_VECTOR = Prisma.raw(`
  to_tsvector(
    'simple'::regconfig,
    coalesce(p."title", '') || ' ' ||
    coalesce(p."shortDescription", '') || ' ' ||
    coalesce(array_to_string(p."projectTags", ' '), '')
  )
`);

function getPublicPositionInclude() {
  return {
    attributes: {
      orderBy: {
        sortOrder: "asc",
      },
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

function serializePublicPosition(position) {
  return {
    id: position.id,
    title: position.title,
    shortDescription: position.shortDescription,
    maxProjects: position.maxProjects,
    projectTags: position.projectTags,
    createdAt: position.createdAt,
    updatedAt: position.updatedAt,
    accessType: "PUBLIC",
    attributes: (position.attributes || []).map((item) => ({
      id: item.attribute.id,
      name: item.attribute.name,
      category: item.attribute.category,
      type: item.attribute.type,
      description: item.attribute.description,
      options: (item.attribute.options || []).map((option) => ({
        id: option.id,
        value: option.value,
        sortOrder: option.sortOrder,
      })),
    })),
  };
}

function buildTechnologyTagCloud(positions) {
  const tagsMap = new Map();

  positions.forEach((position) => {
    (position.projectTags || [])
      .map((tag) => tag.trim())
      .filter(Boolean)
      .forEach((tag) => {
        const normalizedTag = tag.toLowerCase();
        const current = tagsMap.get(normalizedTag);

        if (current) {
          current.count += 1;
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

async function getPublicDashboardData() {
  const positions = await prisma.position.findMany({
    where: {
      isPublic: true,
    },
    select: {
      id: true,
      title: true,
      shortDescription: true,
      projectTags: true,
      updatedAt: true,
      _count: {
        select: {
          cvs: {
            where: {
              status: "PUBLISHED",
            },
          },
        },
      },
    },
  });
  const popularPositions = positions
    .map((position) => ({
      id: position.id,
      title: position.title,
      shortDescription: position.shortDescription,
      publishedCvsCount: position._count.cvs,
      updatedAt: position.updatedAt,
    }))
    .sort((left, right) => {
      if (right.publishedCvsCount !== left.publishedCvsCount) {
        return right.publishedCvsCount - left.publishedCvsCount;
      }

      return right.updatedAt.getTime() - left.updatedAt.getTime();
    })
    .slice(0, 5)
    .map(({ updatedAt, ...item }) => item);
  const publishedCvsCount = positions.reduce(
    (total, position) => total + position._count.cvs,
    0,
  );

  return {
    publicPositionsCount: positions.length,
    publishedCvsCount,
    popularPositions,
    technologyTagCloud: buildTechnologyTagCloud(positions),
  };
}

router.get("/positions", async (req, res) => {
  try {
    const positions = await prisma.position.findMany({
      where: {
        isPublic: true,
      },
      orderBy: {
        updatedAt: "desc",
      },
      include: getPublicPositionInclude(),
    });

    res.json(positions.map(serializePublicPosition));
  } catch (error) {
    console.error("GET /api/public/positions error:", error);
    res.status(500).json({
      message: "Failed to load public positions",
    });
  }
});

router.get("/stats", async (req, res) => {
  try {
    const [totalAttributesCount, dashboardData] = await Promise.all([
      prisma.attribute.count(),
      getPublicDashboardData(),
    ]);

    res.json({
      role: "GUEST",
      stats: {
        publicPositionsCount: dashboardData.publicPositionsCount,
        publishedCvsCount: dashboardData.publishedCvsCount,
        totalAttributesCount,
      },
      popularPositions: dashboardData.popularPositions,
      technologyTagCloud: dashboardData.technologyTagCloud,
    });
  } catch (error) {
    console.error("GET /api/public/stats error:", error);
    res.status(500).json({
      message: "Failed to load public statistics",
    });
  }
});

router.get("/search", async (req, res) => {
  try {
    if (typeof req.query.q !== "string") {
      return res.status(400).json({
        message: "Query parameter q is required",
      });
    }

    const query = normalizeSearchQuery(req.query.q);

    if (query.length < 2) {
      return res.json({
        query,
        role: "GUEST",
        totalCount: 0,
        results: {
          positions: [],
        },
      });
    }

    const positions = await runFullTextQuery(prisma, (tsQuery) => Prisma.sql`
      SELECT
        p.id,
        p.title,
        p."shortDescription",
        ts_rank_cd(${POSITION_VECTOR}, ${tsQuery}) AS rank
      FROM "Position" p
      WHERE p."isPublic" = true
        AND ${POSITION_VECTOR} @@ ${tsQuery}
      ORDER BY rank DESC, p."updatedAt" DESC
      LIMIT 10
    `, query);

    const items = positions.map((position) => ({
      id: position.id,
      title: position.title,
      shortDescription: position.shortDescription,
      type: "position",
    }));

    res.json({
      query,
      role: "GUEST",
      totalCount: items.length,
      results: {
        positions: items,
      },
    });
  } catch (error) {
    console.error("GET /api/public/search error:", error);
    res.status(500).json({
      message: "Failed to search public positions",
    });
  }
});

module.exports = router;
