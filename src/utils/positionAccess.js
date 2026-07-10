const prisma = require("../lib/prisma");

const ACCESS_RULE_OPERATORS_BY_TYPE = {
  NUMERIC: ["GTE", "LTE", "EQ"],
  BOOLEAN: ["EQ"],
  STRING: ["EQ", "IN"],
  SELECT: ["EQ", "IN"],
  DATE: ["GTE", "LTE", "EQ"],
};

function isSupportedAccessRuleAttributeType(attributeType) {
  return Boolean(ACCESS_RULE_OPERATORS_BY_TYPE[attributeType]);
}

function getAllowedOperatorsForAttributeType(attributeType) {
  return ACCESS_RULE_OPERATORS_BY_TYPE[attributeType] || [];
}

function parseInValues(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(",");

  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

function normalizeDateValue(value) {
  const parsedDate = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(parsedDate.getTime())) {
    return null;
  }

  return parsedDate;
}

function validateAndNormalizeAccessRules(accessRules, attributesById) {
  if (accessRules === undefined) {
    return {
      normalizedRules: [],
    };
  }

  if (!Array.isArray(accessRules)) {
    return {
      error: "accessRules must be an array",
    };
  }

  const normalizedRules = [];

  for (let index = 0; index < accessRules.length; index += 1) {
    const rule = accessRules[index] || {};
    const attributeId = Number(rule.attributeId);

    if (!Number.isInteger(attributeId) || attributeId <= 0) {
      return {
        error: `Access rule #${index + 1}: valid attributeId is required`,
      };
    }

    const attribute = attributesById.get(attributeId);

    if (!attribute) {
      return {
        error: `Access rule #${index + 1}: attribute not found`,
      };
    }

    if (!isSupportedAccessRuleAttributeType(attribute.type)) {
      return {
        error: `Access rule #${index + 1}: attribute type ${attribute.type} is not supported`,
      };
    }

    const operator =
      typeof rule.operator === "string" ? rule.operator.trim().toUpperCase() : "";
    const allowedOperators = getAllowedOperatorsForAttributeType(attribute.type);

    if (!allowedOperators.includes(operator)) {
      return {
        error: `Access rule #${index + 1}: operator ${operator || "is required"} is invalid for ${attribute.type}`,
      };
    }

    const normalizedRule = {
      attributeId,
      operator,
      stringValue: null,
      numericValue: null,
      booleanValue: null,
      dateValue: null,
      sortOrder: Number.isInteger(rule.sortOrder) ? rule.sortOrder : index + 1,
    };

    if (attribute.type === "NUMERIC") {
      const numericValue = Number(rule.numericValue);

      if (!Number.isFinite(numericValue)) {
        return {
          error: `Access rule #${index + 1}: numericValue must be a valid number`,
        };
      }

      normalizedRule.numericValue = numericValue;
    }

    if (attribute.type === "BOOLEAN") {
      if (typeof rule.booleanValue !== "boolean") {
        return {
          error: `Access rule #${index + 1}: booleanValue must be boolean`,
        };
      }

      normalizedRule.booleanValue = rule.booleanValue;
    }

    if (attribute.type === "STRING" || attribute.type === "SELECT") {
      if (operator === "IN") {
        const inValues = parseInValues(rule.stringValue);

        if (inValues.length === 0) {
          return {
            error: `Access rule #${index + 1}: stringValue must contain at least one value`,
          };
        }

        normalizedRule.stringValue = inValues.join(",");
      } else {
        const stringValue =
          typeof rule.stringValue === "string" ? rule.stringValue.trim() : "";

        if (!stringValue) {
          return {
            error: `Access rule #${index + 1}: stringValue is required`,
          };
        }

        normalizedRule.stringValue = stringValue;
      }
    }

    if (attribute.type === "DATE") {
      const dateValue = normalizeDateValue(rule.dateValue);

      if (!dateValue) {
        return {
          error: `Access rule #${index + 1}: dateValue must be a valid date`,
        };
      }

      normalizedRule.dateValue = dateValue;
    }

    normalizedRules.push(normalizedRule);
  }

  return {
    normalizedRules,
  };
}

function compareDates(leftDate, rightDate, operator) {
  const leftTime = leftDate.getTime();
  const rightTime = rightDate.getTime();

  if (operator === "GTE") {
    return leftTime >= rightTime;
  }

  if (operator === "LTE") {
    return leftTime <= rightTime;
  }

  return leftTime === rightTime;
}

function doesProfileValueMatchRule(rule, profileValue) {
  if (!profileValue) {
    return false;
  }

  if (rule.attribute?.type === "NUMERIC") {
    if (profileValue.numericValue === null || rule.numericValue === null) {
      return false;
    }

    if (rule.operator === "GTE") {
      return profileValue.numericValue >= rule.numericValue;
    }

    if (rule.operator === "LTE") {
      return profileValue.numericValue <= rule.numericValue;
    }

    return profileValue.numericValue === rule.numericValue;
  }

  if (rule.attribute?.type === "BOOLEAN") {
    if (profileValue.booleanValue === null || rule.booleanValue === null) {
      return false;
    }

    return profileValue.booleanValue === rule.booleanValue;
  }

  if (rule.attribute?.type === "STRING" || rule.attribute?.type === "SELECT") {
    const candidateValue =
      typeof profileValue.stringValue === "string"
        ? profileValue.stringValue.trim()
        : "";

    if (!candidateValue || !rule.stringValue) {
      return false;
    }

    if (rule.operator === "IN") {
      return parseInValues(rule.stringValue).includes(candidateValue);
    }

    return candidateValue === rule.stringValue.trim();
  }

  if (rule.attribute?.type === "DATE") {
    if (!profileValue.dateValue || !rule.dateValue) {
      return false;
    }

    return compareDates(
      new Date(profileValue.dateValue),
      new Date(rule.dateValue),
      rule.operator,
    );
  }

  return false;
}

function evaluatePositionAccessWithProfileValues(position, profileValuesByAttributeId) {
  if (position?.isPublic) {
    return {
      accessible: true,
      failedRules: [],
    };
  }

  const accessRules = Array.isArray(position?.accessRules) ? position.accessRules : [];

  if (accessRules.length === 0) {
    return {
      accessible: false,
      failedRules: [],
    };
  }

  const failedRules = accessRules.filter((rule) => {
    const profileValue = profileValuesByAttributeId.get(rule.attributeId) || null;

    return !doesProfileValueMatchRule(rule, profileValue);
  });

  return {
    accessible: failedRules.length === 0,
    failedRules,
  };
}

async function buildCandidatePositionAccessMap(userId, positions) {
  if (!Array.isArray(positions) || positions.length === 0) {
    return new Map();
  }

  const attributeIds = [
    ...new Set(
      positions.flatMap((position) =>
        (position.accessRules || []).map((rule) => rule.attributeId),
      ),
    ),
  ];

  const profileValues =
    attributeIds.length > 0
      ? await prisma.profileAttributeValue.findMany({
          where: {
            userId,
            attributeId: {
              in: attributeIds,
            },
          },
        })
      : [];

  const profileValuesByAttributeId = new Map(
    profileValues.map((value) => [value.attributeId, value]),
  );

  return new Map(
    positions.map((position) => [
      position.id,
      evaluatePositionAccessWithProfileValues(position, profileValuesByAttributeId),
    ]),
  );
}

async function canCandidateAccessPosition(userId, position) {
  const accessMap = await buildCandidatePositionAccessMap(userId, [position]);

  return accessMap.get(position.id) || { accessible: false, failedRules: [] };
}

function buildPositionAccessMeta(position) {
  return {
    accessType: position.isPublic ? "PUBLIC" : "RESTRICTED",
    accessRulesCount: Array.isArray(position.accessRules) ? position.accessRules.length : 0,
  };
}

module.exports = {
  ACCESS_RULE_OPERATORS_BY_TYPE,
  buildCandidatePositionAccessMap,
  buildPositionAccessMeta,
  canCandidateAccessPosition,
  getAllowedOperatorsForAttributeType,
  isSupportedAccessRuleAttributeType,
  validateAndNormalizeAccessRules,
};
