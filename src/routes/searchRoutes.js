const express = require("express");
const { Prisma } = require("@prisma/client");
const prisma = require("../lib/prisma");
const { buildCandidatePositionAccessMap } = require("../utils/positionAccess");
const {
  normalizeSearchQuery,
  runFullTextQuery,
} = require("../utils/fullTextSearch");

const router = express.Router();

const POSITION_VECTOR = Prisma.raw(`
  to_tsvector(
    'simple'::regconfig,
    coalesce(p."title", '') || ' ' ||
    coalesce(p."shortDescription", '') || ' ' ||
    coalesce(array_to_string(p."projectTags", ' '), '')
  )
`);

const PROJECT_VECTOR = Prisma.raw(`
  to_tsvector(
    'simple'::regconfig,
    coalesce(pr."name", '') || ' ' ||
    coalesce(pr."description", '') || ' ' ||
    coalesce(array_to_string(pr."technologyTags", ' '), '')
  )
`);

const PROFILE_VALUE_VECTOR = Prisma.raw(`
  to_tsvector(
    'simple'::regconfig,
    coalesce(pv."stringValue", '') || ' ' ||
    coalesce(pv."textValue", '') || ' ' ||
    coalesce(pv."numericValue"::text, '') || ' ' ||
    coalesce(pv."booleanValue"::text, '') || ' ' ||
    coalesce(pv."dateValue"::text, '') || ' ' ||
    coalesce(pv."periodStart"::text, '') || ' ' ||
    coalesce(pv."periodEnd"::text, '') || ' ' ||
    coalesce(pv."imageUrl", '')
  )
`);

const ATTRIBUTE_VECTOR = Prisma.raw(`
  to_tsvector(
    'simple'::regconfig,
    coalesce(a."name", '') || ' ' ||
    coalesce(a."category"::text, '') || ' ' ||
    coalesce(a."type"::text, '') || ' ' ||
    coalesce(a."description", '') || ' ' ||
    coalesce(string_agg(ao."value", ' '), '')
  )
`);

const USER_VECTOR = Prisma.raw(`
  to_tsvector(
    'simple'::regconfig,
    coalesce(u."name", '') || ' ' ||
    coalesce(u."email", '')
  )
`);

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

function getStringValue(value) {
  if (value === null || value === undefined || value === "") {
    return "—";
  }

  return String(value);
}

async function searchCandidatePositions(userId, query) {
  const matchedPositions = await runFullTextQuery(prisma, (tsQuery) => Prisma.sql`
    SELECT
      p.id,
      p.title,
      p."shortDescription",
      p."isPublic",
      p."updatedAt",
      ts_rank_cd(${POSITION_VECTOR}, ${tsQuery}) AS rank
    FROM "Position" p
    WHERE ${POSITION_VECTOR} @@ ${tsQuery}
    ORDER BY rank DESC, p."updatedAt" DESC
    LIMIT 25
  `, query);

  if (matchedPositions.length === 0) {
    return [];
  }

  const positionsForAccess = await prisma.position.findMany({
    where: {
      id: {
        in: matchedPositions.map((position) => position.id),
      },
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

  const accessMap = await buildCandidatePositionAccessMap(userId, positionsForAccess);

  return matchedPositions
    .filter((position) => accessMap.get(position.id)?.accessible)
    .slice(0, 10)
    .map((position) => ({
      id: position.id,
      title: position.title,
      shortDescription: position.shortDescription,
      isPublic: position.isPublic,
      type: "position",
    }));
}

async function searchCandidateCvs(userId, query) {
  const matchedCvs = await runFullTextQuery(prisma, (tsQuery) => Prisma.sql`
    SELECT
      cv.id,
      cv.status,
      cv."positionId",
      cv."updatedAt",
      p.title AS "positionTitle",
      COALESCE(COUNT(cl.id), 0)::int AS "likesCount",
      ts_rank_cd(
        to_tsvector(
          'simple'::regconfig,
          coalesce(p.title, '') || ' ' ||
          coalesce(p."shortDescription", '') || ' ' ||
          coalesce(cv.status::text, '') || ' ' ||
          coalesce(array_to_string(p."projectTags", ' '), '')
        ),
        ${tsQuery}
      ) AS rank
    FROM "Cv" cv
    JOIN "Position" p ON p.id = cv."positionId"
    LEFT JOIN "CvLike" cl ON cl."cvId" = cv.id
    WHERE cv."userId" = ${userId}
      AND to_tsvector(
        'simple'::regconfig,
        coalesce(p.title, '') || ' ' ||
        coalesce(p."shortDescription", '') || ' ' ||
        coalesce(cv.status::text, '') || ' ' ||
        coalesce(array_to_string(p."projectTags", ' '), '')
      ) @@ ${tsQuery}
    GROUP BY cv.id, p.id
    ORDER BY rank DESC, cv."updatedAt" DESC
    LIMIT 25
  `, query);

  if (matchedCvs.length === 0) {
    return [];
  }

  const positionsForAccess = await prisma.position.findMany({
    where: {
      id: {
        in: matchedCvs.map((cv) => cv.positionId),
      },
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

  const accessMap = await buildCandidatePositionAccessMap(userId, positionsForAccess);

  return matchedCvs
    .filter((cv) => accessMap.get(cv.positionId)?.accessible)
    .slice(0, 5)
    .map((cv) => ({
      id: cv.id,
      status: cv.status,
      positionTitle: cv.positionTitle || "—",
      updatedAt: cv.updatedAt,
      likesCount: cv.likesCount,
      type: "cv",
    }));
}

async function searchCandidateProjects(userId, query) {
  const projects = await runFullTextQuery(prisma, (tsQuery) => Prisma.sql`
    SELECT
      pr.id,
      pr.name,
      pr.description,
      pr."technologyTags",
      pr."updatedAt",
      ts_rank_cd(${PROJECT_VECTOR}, ${tsQuery}) AS rank
    FROM "Project" pr
    WHERE pr."userId" = ${userId}
      AND ${PROJECT_VECTOR} @@ ${tsQuery}
    ORDER BY rank DESC, pr."updatedAt" DESC
    LIMIT 10
  `, query);

  return projects.map((project) => ({
    id: project.id,
    name: project.name,
    description: project.description,
    technologyTags: project.technologyTags,
    updatedAt: project.updatedAt,
    type: "project",
  }));
}

async function searchCandidateProfileValues(userId, query) {
  const profileValues = await runFullTextQuery(prisma, (tsQuery) => Prisma.sql`
    SELECT
      pv.id,
      pv."updatedAt",
      a.id AS "attributeId",
      a.name AS "attributeName",
      a.type AS "attributeType",
      COALESCE(
        NULLIF(pv."stringValue", ''),
        NULLIF(pv."textValue", ''),
        pv."numericValue"::text,
        pv."booleanValue"::text,
        pv."dateValue"::text,
        pv."periodStart"::text,
        pv."imageUrl",
        '—'
      ) AS value,
      GREATEST(
        ts_rank_cd(${PROFILE_VALUE_VECTOR}, ${tsQuery}),
        ts_rank_cd(
          to_tsvector(
            'simple'::regconfig,
            coalesce(a.name, '') || ' ' ||
            coalesce(a.category::text, '') || ' ' ||
            coalesce(a.type::text, '')
          ),
          ${tsQuery}
        )
      ) AS rank
    FROM "ProfileAttributeValue" pv
    JOIN "Attribute" a ON a.id = pv."attributeId"
    WHERE pv."userId" = ${userId}
      AND (
        ${PROFILE_VALUE_VECTOR} @@ ${tsQuery}
        OR to_tsvector(
          'simple'::regconfig,
          coalesce(a.name, '') || ' ' ||
          coalesce(a.category::text, '') || ' ' ||
          coalesce(a.type::text, '')
        ) @@ ${tsQuery}
      )
    ORDER BY rank DESC, pv."updatedAt" DESC
    LIMIT 10
  `, query);

  return profileValues.map((value) => ({
    id: value.id,
    attributeId: value.attributeId,
    attributeName: value.attributeName,
    attributeType: value.attributeType,
    value: value.value || "—",
    updatedAt: value.updatedAt,
    type: "profileValue",
  }));
}

async function searchCandidate(userId, query) {
  const [positions, cvs, projects, profileValues] = await Promise.all([
    searchCandidatePositions(userId, query),
    searchCandidateCvs(userId, query),
    searchCandidateProjects(userId, query),
    searchCandidateProfileValues(userId, query),
  ]);

  return {
    positions,
    cvs,
    projects,
    profileValues,
  };
}

async function searchRecruiterPositions(query) {
  const positions = await runFullTextQuery(prisma, (tsQuery) => Prisma.sql`
    SELECT
      p.id,
      p.title,
      p."shortDescription",
      p."isPublic",
      ts_rank_cd(${POSITION_VECTOR}, ${tsQuery}) AS rank
    FROM "Position" p
    WHERE ${POSITION_VECTOR} @@ ${tsQuery}
    ORDER BY rank DESC, p."updatedAt" DESC
    LIMIT 10
  `, query);

  return positions.map((position) => ({
    id: position.id,
    title: position.title,
    shortDescription: position.shortDescription,
    isPublic: position.isPublic,
    type: "position",
  }));
}

async function searchRecruiterAttributes(query) {
  const attributes = await runFullTextQuery(prisma, (tsQuery) => Prisma.sql`
    SELECT
      a.id,
      a.name,
      a.category,
      a.type,
      a.description,
      ts_rank_cd(${ATTRIBUTE_VECTOR}, ${tsQuery}) AS rank
    FROM "Attribute" a
    LEFT JOIN "AttributeOption" ao ON ao."attributeId" = a.id
    GROUP BY a.id
    HAVING ${ATTRIBUTE_VECTOR} @@ ${tsQuery}
    ORDER BY rank DESC, a."updatedAt" DESC
    LIMIT 10
  `, query);

  return attributes.map((attribute) => ({
    id: attribute.id,
    name: attribute.name,
    category: attribute.category,
    type: attribute.type,
    description: attribute.description,
    resultType: "attribute",
  }));
}

async function searchRecruiterPublishedCvs(userId, query) {
  const publishedCvs = await runFullTextQuery(prisma, (tsQuery) => Prisma.sql`
    SELECT
      cv.id,
      cv.status,
      cv."updatedAt",
      p.title AS "positionTitle",
      u.name AS "candidateName",
      u.email AS "candidateEmail",
      COALESCE(COUNT(cl.id), 0)::int AS "likesCount",
      BOOL_OR(my_like.id IS NOT NULL) AS "likedByCurrentUser",
      ts_rank_cd(
        to_tsvector(
          'simple'::regconfig,
          coalesce(u.name, '') || ' ' ||
          coalesce(u.email, '') || ' ' ||
          coalesce(p.title, '') || ' ' ||
          coalesce(p."shortDescription", '') || ' ' ||
          coalesce(cv.status::text, '')
        ),
        ${tsQuery}
      ) AS rank
    FROM "Cv" cv
    JOIN "User" u ON u.id = cv."userId"
    JOIN "Position" p ON p.id = cv."positionId"
    LEFT JOIN "CvLike" cl ON cl."cvId" = cv.id
    LEFT JOIN "CvLike" my_like ON my_like."cvId" = cv.id AND my_like."userId" = ${userId}
    WHERE cv.status = 'PUBLISHED'
      AND to_tsvector(
        'simple'::regconfig,
        coalesce(u.name, '') || ' ' ||
        coalesce(u.email, '') || ' ' ||
        coalesce(p.title, '') || ' ' ||
        coalesce(p."shortDescription", '') || ' ' ||
        coalesce(cv.status::text, '')
      ) @@ ${tsQuery}
    GROUP BY cv.id, p.id, u.id
    ORDER BY rank DESC, cv."updatedAt" DESC
    LIMIT 10
  `, query);

  return publishedCvs.map((cv) => ({
    id: cv.id,
    status: cv.status,
    positionTitle: cv.positionTitle || "—",
    candidateName: cv.candidateName || "—",
    candidateEmail: cv.candidateEmail || "—",
    updatedAt: cv.updatedAt,
    likesCount: cv.likesCount,
    likedByCurrentUser: Boolean(cv.likedByCurrentUser),
    type: "publishedCv",
  }));
}

async function searchRecruiterCandidates(query) {
  const candidates = await runFullTextQuery(prisma, (tsQuery) => Prisma.sql`
    SELECT
      u.id,
      u.name,
      u.email,
      ts_rank_cd(${USER_VECTOR}, ${tsQuery}) AS rank
    FROM "User" u
    WHERE EXISTS (
      SELECT 1
      FROM "UserRole" ur
      JOIN "Role" r ON r.id = ur."roleId"
      WHERE ur."userId" = u.id
        AND r.name = 'CANDIDATE'
    )
      AND EXISTS (
        SELECT 1
        FROM "Cv" cv
        WHERE cv."userId" = u.id
          AND cv.status = 'PUBLISHED'
      )
      AND ${USER_VECTOR} @@ ${tsQuery}
    ORDER BY rank DESC, u."updatedAt" DESC
    LIMIT 10
  `, query);

  return candidates.map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    email: candidate.email,
    type: "candidate",
  }));
}

async function searchRecruiter(userId, query) {
  const [positions, attributes, publishedCvs, candidates] = await Promise.all([
    searchRecruiterPositions(query),
    searchRecruiterAttributes(query),
    searchRecruiterPublishedCvs(userId, query),
    searchRecruiterCandidates(query),
  ]);

  return {
    positions,
    attributes,
    publishedCvs,
    candidates,
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

    const trimmedQuery = normalizeSearchQuery(req.query.q);
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

    const results =
      viewerRole === "CANDIDATE"
        ? await searchCandidate(currentUser.id, trimmedQuery)
        : await searchRecruiter(currentUser.id, trimmedQuery);

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
