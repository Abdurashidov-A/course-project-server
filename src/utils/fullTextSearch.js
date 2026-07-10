const { Prisma } = require("@prisma/client");

const SEARCH_CONFIG_SQL = Prisma.raw("'simple'::regconfig");

function normalizeSearchQuery(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().replace(/\s+/g, " ").slice(0, 100);
}

function buildTsQuery(mode, query) {
  if (mode === "plain") {
    return Prisma.sql`plainto_tsquery(${SEARCH_CONFIG_SQL}, ${query})`;
  }

  return Prisma.sql`websearch_to_tsquery(${SEARCH_CONFIG_SQL}, ${query})`;
}

async function runFullTextQuery(prisma, buildSql, query) {
  try {
    return await prisma.$queryRaw(buildSql(buildTsQuery("web", query)));
  } catch (error) {
    return prisma.$queryRaw(buildSql(buildTsQuery("plain", query)));
  }
}

module.exports = {
  SEARCH_CONFIG_SQL,
  buildTsQuery,
  normalizeSearchQuery,
  runFullTextQuery,
};
