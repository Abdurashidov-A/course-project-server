const express = require("express");
const prisma = require("../lib/prisma");
const defaultTokenService = require("../integrations/odooService");

const AUTH_ERROR_MESSAGE = "Invalid or missing Odoo API token";

function getBearerToken(req) {
  const authorization = req.get("authorization");

  if (typeof authorization !== "string") {
    return null;
  }

  const match = /^Bearer ([^\s]+)$/.exec(authorization);

  return match ? match[1] : null;
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numericValue =
    typeof value?.toNumber === "function" ? value.toNumber() : Number(value);

  return Number.isFinite(numericValue) ? numericValue : null;
}

function toValidDate(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function buildCounts(filledCount, publishedCvCount) {
  const safeFilledCount = Math.min(
    Math.max(filledCount, 0),
    Math.max(publishedCvCount, 0),
  );

  return {
    filledCount: safeFilledCount,
    missingCount: Math.max(0, publishedCvCount - safeFilledCount),
  };
}

function calculateFiniteAverage(values) {
  const scale = values.reduce(
    (largestMagnitude, value) =>
      Math.max(largestMagnitude, Math.abs(value)),
    0,
  );

  if (scale === 0) {
    return 0;
  }

  const normalizedSum = values.reduce(
    (total, value) => total + value / scale,
    0,
  );
  const normalizedAverage = normalizedSum / values.length;
  const boundedAverage = Math.max(-1, Math.min(1, normalizedAverage));
  const scaledAverage = boundedAverage * scale;
  const finiteAverage = Number.isFinite(scaledAverage)
    ? scaledAverage
    : Math.sign(boundedAverage) * scale;
  const min = values.reduce(
    (smallestValue, value) => Math.min(smallestValue, value),
    values[0],
  );
  const max = values.reduce(
    (largestValue, value) => Math.max(largestValue, value),
    values[0],
  );

  return Math.min(max, Math.max(min, finiteAverage));
}

function buildNumericStatistics(values, publishedCvCount) {
  const numericValues = values
    .map((value) => toFiniteNumber(value.numericValue))
    .filter((value) => value !== null);
  const counts = buildCounts(numericValues.length, publishedCvCount);

  if (numericValues.length === 0) {
    return {
      kind: "NUMERIC",
      ...counts,
      average: null,
      min: null,
      max: null,
    };
  }

  return {
    kind: "NUMERIC",
    ...counts,
    average: calculateFiniteAverage(numericValues),
    min: Math.min(...numericValues),
    max: Math.max(...numericValues),
  };
}

function buildBooleanStatistics(values, publishedCvCount) {
  const booleanValues = values
    .map((value) => value.booleanValue)
    .filter((value) => typeof value === "boolean");
  const trueCount = booleanValues.filter((value) => value).length;
  const falseCount = booleanValues.length - trueCount;

  return {
    kind: "BOOLEAN",
    ...buildCounts(booleanValues.length, publishedCvCount),
    trueCount,
    falseCount,
  };
}

function buildPopularValuesStatistics(values, publishedCvCount, field) {
  const frequencies = new Map();

  values.forEach((value) => {
    const text = value[field];

    if (!isNonEmptyString(text)) {
      return;
    }

    frequencies.set(text, (frequencies.get(text) || 0) + 1);
  });

  const topValues = [...frequencies.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => {
      if (left.count !== right.count) {
        return right.count - left.count;
      }

      if (left.value < right.value) {
        return -1;
      }

      return left.value > right.value ? 1 : 0;
    })
    .slice(0, 5);
  const filledCount = [...frequencies.values()].reduce(
    (total, count) => total + count,
    0,
  );

  return {
    kind: "POPULAR_VALUES",
    ...buildCounts(filledCount, publishedCvCount),
    topValues,
  };
}

function buildDateStatistics(values, publishedCvCount) {
  const dates = values
    .map((value) => toValidDate(value.dateValue))
    .filter((value) => value !== null);
  const counts = buildCounts(dates.length, publishedCvCount);

  if (dates.length === 0) {
    return {
      kind: "DATE_RANGE",
      ...counts,
      earliest: null,
      latest: null,
    };
  }

  const timestamps = dates.map((date) => date.getTime());

  return {
    kind: "DATE_RANGE",
    ...counts,
    earliest: new Date(Math.min(...timestamps)).toISOString(),
    latest: new Date(Math.max(...timestamps)).toISOString(),
  };
}

function buildPeriodStatistics(values, publishedCvCount) {
  const periods = values
    .map((value) => ({
      start: toValidDate(value.periodStart),
      end: toValidDate(value.periodEnd),
    }))
    .filter((period) => period.start !== null && period.end !== null);
  const counts = buildCounts(periods.length, publishedCvCount);

  if (periods.length === 0) {
    return {
      kind: "PERIOD_RANGE",
      ...counts,
      earliestStart: null,
      latestEnd: null,
    };
  }

  return {
    kind: "PERIOD_RANGE",
    ...counts,
    earliestStart: new Date(
      Math.min(...periods.map((period) => period.start.getTime())),
    ).toISOString(),
    latestEnd: new Date(
      Math.max(...periods.map((period) => period.end.getTime())),
    ).toISOString(),
  };
}

function buildImageStatistics(values, publishedCvCount) {
  const filledCount = values.filter((value) =>
    isNonEmptyString(value.imageUrl),
  ).length;

  return {
    kind: "COMPLETENESS",
    ...buildCounts(filledCount, publishedCvCount),
  };
}

function hasAnySafeValue(value) {
  return (
    isNonEmptyString(value.stringValue) ||
    isNonEmptyString(value.textValue) ||
    toFiniteNumber(value.numericValue) !== null ||
    typeof value.booleanValue === "boolean" ||
    toValidDate(value.dateValue) !== null ||
    (toValidDate(value.periodStart) !== null &&
      toValidDate(value.periodEnd) !== null) ||
    isNonEmptyString(value.imageUrl)
  );
}

function buildFallbackStatistics(values, publishedCvCount) {
  return {
    kind: "COMPLETENESS",
    ...buildCounts(
      values.filter((value) => hasAnySafeValue(value)).length,
      publishedCvCount,
    ),
  };
}

function buildStatistics(type, values, publishedCvCount) {
  if (type === "NUMERIC") {
    return buildNumericStatistics(values, publishedCvCount);
  }

  if (type === "BOOLEAN") {
    return buildBooleanStatistics(values, publishedCvCount);
  }

  if (type === "STRING" || type === "SELECT") {
    return buildPopularValuesStatistics(
      values,
      publishedCvCount,
      "stringValue",
    );
  }

  if (type === "TEXT") {
    return buildPopularValuesStatistics(
      values,
      publishedCvCount,
      "textValue",
    );
  }

  if (type === "DATE") {
    return buildDateStatistics(values, publishedCvCount);
  }

  if (type === "PERIOD") {
    return buildPeriodStatistics(values, publishedCvCount);
  }

  if (type === "IMAGE") {
    return buildImageStatistics(values, publishedCvCount);
  }

  return buildFallbackStatistics(values, publishedCvCount);
}

function groupValuesByAttribute(profileValues, userIds, attributeIds) {
  const allowedUserIds = new Set(userIds);
  const allowedAttributeIds = new Set(attributeIds);
  const valuesByAttributeId = new Map();

  profileValues.forEach((value) => {
    if (
      !allowedUserIds.has(value.userId) ||
      !allowedAttributeIds.has(value.attributeId)
    ) {
      return;
    }

    if (!valuesByAttributeId.has(value.attributeId)) {
      valuesByAttributeId.set(value.attributeId, new Map());
    }

    valuesByAttributeId.get(value.attributeId).set(value.userId, value);
  });

  return new Map(
    [...valuesByAttributeId.entries()].map(([attributeId, valuesByUserId]) => [
      attributeId,
      [...valuesByUserId.values()],
    ]),
  );
}

function getSafeErrorMeta(error) {
  const name = typeof error?.name === "string" ? error.name : "Error";
  const code = typeof error?.code === "string" ? error.code : null;

  return {
    name: /^[A-Za-z0-9_]+$/.test(name) ? name : "Error",
    code: code && /^[A-Z0-9_]+$/.test(code) ? code : null,
  };
}

function createOdooExternalRouter(options = {}) {
  const router = express.Router();
  const prismaClient = options.prismaClient || prisma;
  const tokenService = options.tokenService || defaultTokenService;
  const profileValueSelect = {
    userId: true,
    attributeId: true,
    stringValue: true,
    textValue: true,
    numericValue: true,
    booleanValue: true,
    dateValue: true,
    periodStart: true,
    periodEnd: true,
    imageUrl: true,
  };

  router.get("/position", async (req, res) => {
    res.set("Cache-Control", "no-store");

    try {
      const rawToken = getBearerToken(req);

      if (!rawToken) {
        return res.status(401).json({ message: AUTH_ERROR_MESSAGE });
      }

      const tokenHash = tokenService.hashToken(rawToken);
      const tokenRecord = await prismaClient.positionOdooToken.findUnique({
        where: {
          tokenHash,
        },
        select: {
          revokedAt: true,
          position: {
            select: {
              id: true,
              title: true,
            },
          },
        },
      });

      if (
        !tokenRecord ||
        tokenRecord.revokedAt !== null ||
        !tokenRecord.position
      ) {
        return res.status(401).json({ message: AUTH_ERROR_MESSAGE });
      }

      const positionId = tokenRecord.position.id;
      const positionAttributes = await prismaClient.positionAttribute.findMany({
        where: {
          positionId,
        },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        select: {
          id: true,
          attributeId: true,
          isRequired: true,
          sortOrder: true,
          attribute: {
            select: {
              id: true,
              name: true,
              type: true,
            },
          },
        },
      });
      const publishedCvs = await prismaClient.cv.findMany({
        where: {
          positionId,
          status: "PUBLISHED",
        },
        select: {
          userId: true,
        },
      });
      const userIds = publishedCvs.map((cv) => cv.userId);
      const attributeIds = positionAttributes.map(
        (positionAttribute) => positionAttribute.attributeId,
      );
      let profileValues = [];

      if (userIds.length > 0 && attributeIds.length > 0) {
        profileValues = await prismaClient.profileAttributeValue.findMany({
          where: {
            userId: {
              in: userIds,
            },
            attributeId: {
              in: attributeIds,
            },
          },
          select: profileValueSelect,
        });
      }

      const valuesByAttributeId = groupValuesByAttribute(
        profileValues,
        userIds,
        attributeIds,
      );
      const publishedCvCount = publishedCvs.length;

      return res.json({
        position: tokenRecord.position,
        dataset: {
          cvStatus: "PUBLISHED",
          publishedCvCount,
        },
        attributes: positionAttributes.map((positionAttribute) => ({
          id: positionAttribute.attribute.id,
          name: positionAttribute.attribute.name,
          type: positionAttribute.attribute.type,
          isRequired: positionAttribute.isRequired,
          sortOrder: positionAttribute.sortOrder,
          statistics: buildStatistics(
            positionAttribute.attribute.type,
            valuesByAttributeId.get(positionAttribute.attributeId) || [],
            publishedCvCount,
          ),
        })),
      });
    } catch (error) {
      console.error(
        "GET /api/integrations/odoo/position failed",
        getSafeErrorMeta(error),
      );

      return res.status(500).json({
        message: "Failed to load Odoo position results",
      });
    }
  });

  return router;
}

module.exports = {
  createOdooExternalRouter,
};
