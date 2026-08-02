const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const express = require("express");
const {
  createOdooExternalRouter,
} = require("../src/routes/odooExternalRoutes");

const POSITION_ID = 8;
const OTHER_POSITION_ID = 9;
const RAW_TOKEN = `cvms_odoo_${"a".repeat(43)}`;
const UNKNOWN_TOKEN = `cvms_odoo_${"b".repeat(43)}`;
const TOKEN_HASH = "active-token-hash";
const AUTH_ERROR = {
  message: "Invalid or missing Odoo API token",
};
const FORBIDDEN_RESPONSE_KEYS = [
  "userId",
  "candidate",
  "email",
  "profileAttributeValues",
  "tokenHash",
  "tokenHint",
  "rawToken",
  "createdById",
  "stringValue",
  "textValue",
  "numericValue",
  "booleanValue",
  "dateValue",
  "periodStart",
  "periodEnd",
  "imageUrl",
];

function createToken(overrides = {}) {
  return {
    tokenHash: TOKEN_HASH,
    revokedAt: null,
    position: {
      id: POSITION_ID,
      title: "Frontend Developer",
    },
    ...overrides,
  };
}

function createPositionAttribute({
  id,
  attributeId,
  type,
  name = `${type} Attribute`,
  positionId = POSITION_ID,
  isRequired = false,
  sortOrder = 0,
}) {
  return {
    id,
    positionId,
    attributeId,
    isRequired,
    sortOrder,
    attribute: {
      id: attributeId,
      name,
      type,
    },
  };
}

function createCv(userId, overrides = {}) {
  return {
    userId,
    positionId: POSITION_ID,
    status: "PUBLISHED",
    ...overrides,
  };
}

function createProfileValue(userId, attributeId, overrides = {}) {
  return {
    userId,
    attributeId,
    stringValue: null,
    textValue: null,
    numericValue: null,
    booleanValue: null,
    dateValue: null,
    periodStart: null,
    periodEnd: null,
    imageUrl: null,
    ...overrides,
  };
}

function applySelect(record, select) {
  if (!record || !select) {
    return record;
  }

  return Object.fromEntries(
    Object.entries(select)
      .filter(([, selection]) => Boolean(selection))
      .map(([key, selection]) => {
        if (selection === true) {
          return [key, record[key]];
        }

        if (selection.select) {
          return [key, applySelect(record[key], selection.select)];
        }

        return [key, record[key]];
      }),
  );
}

function applyOrderBy(records, orderBy) {
  const rules = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];

  return [...records].sort((left, right) => {
    for (const rule of rules) {
      const [[field, direction]] = Object.entries(rule);

      if (left[field] === right[field]) {
        continue;
      }

      const comparison = left[field] < right[field] ? -1 : 1;
      return direction === "desc" ? -comparison : comparison;
    }

    return 0;
  });
}

function createMockPrisma(options = {}) {
  const token = Object.prototype.hasOwnProperty.call(options, "token")
    ? options.token
    : createToken();
  const positionAttributes = options.positionAttributes || [];
  const cvs = options.cvs || [];
  const profileValues = options.profileValues || [];
  const errors = options.errors || {};
  const calls = {
    tokenFindUnique: [],
    positionAttributeFindMany: [],
    cvFindMany: [],
    profileValueFindMany: [],
    textCompletenessQueries: [],
    textCompletenessResults: [],
    mutations: [],
  };

  const recordMutation = (model, method) => async (args) => {
    calls.mutations.push({ model, method, args });
    return null;
  };

  const prismaClient = {
    positionOdooToken: {
      async findUnique(args) {
        calls.tokenFindUnique.push(args);

        if (errors.tokenFindUnique) {
          throw errors.tokenFindUnique;
        }

        if (!token || args.where?.tokenHash !== token.tokenHash) {
          return null;
        }

        return applySelect(token, args.select);
      },
    },
    positionAttribute: {
      async findMany(args) {
        calls.positionAttributeFindMany.push(args);

        if (errors.positionAttributeFindMany) {
          throw errors.positionAttributeFindMany;
        }

        const filtered = args.where?.positionId
          ? positionAttributes.filter(
              (item) => item.positionId === args.where.positionId,
            )
          : positionAttributes;

        return applyOrderBy(filtered, args.orderBy).map((record) =>
          applySelect(record, args.select),
        );
      },
    },
    cv: {
      async findMany(args) {
        calls.cvFindMany.push(args);

        if (errors.cvFindMany) {
          throw errors.cvFindMany;
        }

        const filtered = cvs.filter((cv) => {
          const matchesPosition =
            args.where?.positionId === undefined ||
            cv.positionId === args.where.positionId;
          const matchesStatus =
            args.where?.status === undefined || cv.status === args.where.status;

          return matchesPosition && matchesStatus;
        });

        return filtered.map((record) => applySelect(record, args.select));
      },
    },
    profileAttributeValue: {
      async findMany(args) {
        calls.profileValueFindMany.push(args);

        if (errors.profileValueFindMany) {
          throw errors.profileValueFindMany;
        }

        const allowedUserIds = args.where?.userId?.in;
        const allowedAttributeIds = args.where?.attributeId?.in;
        const filtered = profileValues.filter((value) => {
          const matchesUser =
            !Array.isArray(allowedUserIds) ||
            allowedUserIds.includes(value.userId);
          const matchesAttribute =
            !Array.isArray(allowedAttributeIds) ||
            allowedAttributeIds.includes(value.attributeId);

          return matchesUser && matchesAttribute;
        });

        return filtered.map((record) => applySelect(record, args.select));
      },
    },
  };

  for (const [modelName, model] of Object.entries(prismaClient)) {
    for (const method of [
      "create",
      "update",
      "updateMany",
      "upsert",
      "delete",
      "deleteMany",
    ]) {
      model[method] = recordMutation(modelName, method);
    }
  }

  prismaClient.$queryRaw = async (query) => {
    calls.textCompletenessQueries.push(query);

    if (errors.textCompletenessQuery) {
      throw errors.textCompletenessQuery;
    }

    const publishedUserIds = cvs
      .filter(
        (cv) =>
          cv.positionId === POSITION_ID && cv.status === "PUBLISHED",
      )
      .map((cv) => cv.userId);
    const textAttributeIds = positionAttributes
      .filter(
        (positionAttribute) =>
          positionAttribute.positionId === POSITION_ID &&
          positionAttribute.attribute.type === "TEXT",
      )
      .map((positionAttribute) => positionAttribute.attributeId);
    const results = textAttributeIds
      .map((attributeId) => ({
        attributeId,
        filledCount: profileValues.filter(
          (value) =>
            publishedUserIds.includes(value.userId) &&
            value.attributeId === attributeId &&
            typeof value.textValue === "string" &&
            value.textValue.trim().length > 0,
        ).length,
      }))
      .filter((result) => result.filledCount > 0);

    calls.textCompletenessResults.push(results);
    return results;
  };

  return {
    calls,
    prismaClient,
  };
}

function createMockTokenService() {
  const calls = {
    hashToken: [],
  };

  return {
    calls,
    tokenService: {
      hashToken(rawToken) {
        calls.hashToken.push(rawToken);
        return rawToken === RAW_TOKEN ? TOKEN_HASH : `unknown-hash`;
      },
    },
  };
}

function createTestApp(options = {}) {
  const prisma = createMockPrisma(options.prisma);
  const tokenService = createMockTokenService();
  const app = express();

  app.use(express.json());
  app.use(
    "/api/integrations/odoo",
    createOdooExternalRouter({
      prismaClient: prisma.prismaClient,
      tokenService: tokenService.tokenService,
    }),
  );

  return {
    app,
    prisma,
    tokenService,
  };
}

async function withServer(app, callback) {
  const server = app.listen(0);

  await new Promise((resolve) => {
    server.once("listening", resolve);
  });

  try {
    const { port } = server.address();
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  assert.equal(server.listening, false);
}

function assertNoForbiddenKeys(value, forbiddenKeys = FORBIDDEN_RESPONSE_KEYS) {
  if (Array.isArray(value)) {
    value.forEach((item) => assertNoForbiddenKeys(item, forbiddenKeys));
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  Object.entries(value).forEach(([key, nestedValue]) => {
    assert.equal(forbiddenKeys.includes(key), false, `Unexpected key: ${key}`);
    assertNoForbiddenKeys(nestedValue, forbiddenKeys);
  });
}

async function request(baseUrl, path, options = {}) {
  const url = new URL(path, baseUrl);
  const body =
    options.body === undefined ? null : JSON.stringify(options.body);
  const headers = {};

  if (options.authorization !== null) {
    headers.Authorization =
      options.authorization === undefined
        ? `Bearer ${RAW_TOKEN}`
        : options.authorization;
  }

  if (body !== null) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(body);
  }

  const result = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers,
      },
      (res) => {
        const chunks = [];

        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const responseBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));

          resolve({
            body: responseBody,
            headers: res.headers,
            status: res.statusCode,
          });
        });
      },
    );

    req.on("error", reject);

    if (body !== null) {
      req.write(body);
    }

    req.end();
  });

  assertNoForbiddenKeys(result.body);

  return result;
}

function getAttribute(responseBody, attributeId) {
  return responseBody.attributes.find(
    (attribute) => attribute.id === attributeId,
  );
}

test("rejects every invalid authentication form with the same safe 401 response", async () => {
  const active = createTestApp();

  await withServer(active.app, async (baseUrl) => {
    const results = [
      await request(baseUrl, "/api/integrations/odoo/position", {
        authorization: null,
      }),
      await request(baseUrl, "/api/integrations/odoo/position", {
        authorization: `Basic ${RAW_TOKEN}`,
      }),
      await request(baseUrl, "/api/integrations/odoo/position", {
        authorization: "Bearer",
      }),
      await request(baseUrl, "/api/integrations/odoo/position", {
        authorization: `Bearer ${UNKNOWN_TOKEN}`,
      }),
    ];

    results.forEach((result) => {
      assert.equal(result.status, 401);
      assert.deepEqual(result.body, AUTH_ERROR);
      assert.equal(result.headers["cache-control"], "no-store");
    });
  });

  const revoked = createTestApp({
    prisma: {
      token: createToken({
        revokedAt: new Date("2026-08-01T10:00:00.000Z"),
      }),
    },
  });

  await withServer(revoked.app, async (baseUrl) => {
    const result = await request(baseUrl, "/api/integrations/odoo/position");

    assert.equal(result.status, 401);
    assert.deepEqual(result.body, AUTH_ERROR);
    assert.equal(result.headers["cache-control"], "no-store");
  });
});

test("uses the token-linked position and filters every dataset query", async () => {
  const positionAttributes = [
    createPositionAttribute({
      id: 13,
      attributeId: 3,
      type: "STRING",
      sortOrder: 2,
    }),
    createPositionAttribute({
      id: 12,
      attributeId: 2,
      type: "BOOLEAN",
      sortOrder: 0,
    }),
    createPositionAttribute({
      id: 11,
      attributeId: 1,
      type: "NUMERIC",
      isRequired: true,
      sortOrder: 0,
    }),
    createPositionAttribute({
      id: 14,
      attributeId: 99,
      type: "STRING",
      positionId: OTHER_POSITION_ID,
      sortOrder: 0,
    }),
  ];
  const cvs = [
    createCv("published-1"),
    createCv("published-2"),
    createCv("draft-user", { status: "DRAFT" }),
    createCv("other-position-user", { positionId: OTHER_POSITION_ID }),
  ];
  const profileValues = [
    createProfileValue("published-1", 1, { numericValue: 6 }),
    createProfileValue("published-2", 1, { numericValue: 8 }),
    createProfileValue("draft-user", 1, { numericValue: 100 }),
    createProfileValue("other-position-user", 1, { numericValue: 200 }),
    createProfileValue("published-1", 99, { stringValue: "Outside" }),
  ];
  const { app, prisma, tokenService } = createTestApp({
    prisma: {
      positionAttributes,
      cvs,
      profileValues,
    },
  });

  await withServer(app, async (baseUrl) => {
    const result = await request(
      baseUrl,
      "/api/integrations/odoo/position?positionId=9",
      { body: { positionId: 9 } },
    );

    assert.equal(result.status, 200);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.deepEqual(result.body.position, {
      id: POSITION_ID,
      title: "Frontend Developer",
    });
    assert.deepEqual(result.body.dataset, {
      cvStatus: "PUBLISHED",
      publishedCvCount: 2,
    });
    assert.deepEqual(
      result.body.attributes.map((attribute) => attribute.id),
      [1, 2, 3],
    );
    assert.deepEqual(getAttribute(result.body, 1).statistics, {
      kind: "NUMERIC",
      filledCount: 2,
      missingCount: 0,
      average: 7,
      min: 6,
      max: 8,
    });

    assert.deepEqual(tokenService.calls.hashToken, [RAW_TOKEN]);
    assert.deepEqual(prisma.calls.tokenFindUnique[0].where, {
      tokenHash: TOKEN_HASH,
    });
    assert.equal(
      JSON.stringify(prisma.calls.tokenFindUnique[0]).includes(RAW_TOKEN),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        prisma.calls.tokenFindUnique[0].select,
        "tokenHash",
      ),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        prisma.calls.tokenFindUnique[0].select,
        "tokenHint",
      ),
      false,
    );
    assert.deepEqual(prisma.calls.positionAttributeFindMany[0].where, {
      positionId: POSITION_ID,
    });
    assert.deepEqual(prisma.calls.positionAttributeFindMany[0].orderBy, [
      { sortOrder: "asc" },
      { id: "asc" },
    ]);
    assert.deepEqual(prisma.calls.cvFindMany[0].where, {
      positionId: POSITION_ID,
      status: "PUBLISHED",
    });
    assert.deepEqual(prisma.calls.profileValueFindMany[0].where, {
      userId: {
        in: ["published-1", "published-2"],
      },
      attributeId: {
        in: [1, 2, 3],
      },
    });
    assert.equal(prisma.calls.tokenFindUnique.length, 1);
    assert.equal(prisma.calls.positionAttributeFindMany.length, 1);
    assert.equal(prisma.calls.cvFindMany.length, 1);
    assert.equal(prisma.calls.profileValueFindMany.length, 1);
    assert.deepEqual(prisma.calls.mutations, []);
  });
});

test("returns type-specific empty statistics when no published CV exists", async () => {
  const types = [
    "NUMERIC",
    "BOOLEAN",
    "STRING",
    "SELECT",
    "TEXT",
    "DATE",
    "PERIOD",
    "IMAGE",
  ];
  const { app, prisma } = createTestApp({
    prisma: {
      positionAttributes: types.map((type, index) =>
        createPositionAttribute({
          id: index + 1,
          attributeId: index + 1,
          type,
          sortOrder: index,
        }),
      ),
      cvs: [createCv("draft-user", { status: "DRAFT" })],
      profileValues: [
        createProfileValue("draft-user", 1, { numericValue: 10 }),
      ],
    },
  });

  await withServer(app, async (baseUrl) => {
    const result = await request(baseUrl, "/api/integrations/odoo/position");

    assert.equal(result.status, 200);
    assert.equal(result.body.dataset.publishedCvCount, 0);
    assert.equal(prisma.calls.profileValueFindMany.length, 0);
    result.body.attributes.forEach((attribute) => {
      assert.equal(attribute.statistics.filledCount, 0);
      assert.equal(attribute.statistics.missingCount, 0);
    });
    assert.deepEqual(getAttribute(result.body, 1).statistics, {
      kind: "NUMERIC",
      filledCount: 0,
      missingCount: 0,
      average: null,
      min: null,
      max: null,
    });
    assert.deepEqual(getAttribute(result.body, 2).statistics, {
      kind: "BOOLEAN",
      filledCount: 0,
      missingCount: 0,
      trueCount: 0,
      falseCount: 0,
    });
    for (const attributeId of [3, 4]) {
      assert.deepEqual(getAttribute(result.body, attributeId).statistics, {
        kind: "POPULAR_VALUES",
        filledCount: 0,
        missingCount: 0,
        topValues: [],
      });
    }
    assert.deepEqual(getAttribute(result.body, 5).statistics, {
      kind: "COMPLETENESS",
      filledCount: 0,
      missingCount: 0,
    });
    assert.deepEqual(getAttribute(result.body, 6).statistics, {
      kind: "DATE_RANGE",
      filledCount: 0,
      missingCount: 0,
      earliest: null,
      latest: null,
    });
    assert.deepEqual(getAttribute(result.body, 7).statistics, {
      kind: "PERIOD_RANGE",
      filledCount: 0,
      missingCount: 0,
      earliestStart: null,
      latestEnd: null,
    });
    assert.deepEqual(getAttribute(result.body, 8).statistics, {
      kind: "COMPLETENESS",
      filledCount: 0,
      missingCount: 0,
    });
  });
});

test("returns an empty attribute list without querying profile values", async () => {
  const { app, prisma } = createTestApp({
    prisma: {
      positionAttributes: [],
      cvs: [createCv("published-1")],
    },
  });

  await withServer(app, async (baseUrl) => {
    const result = await request(baseUrl, "/api/integrations/odoo/position");

    assert.equal(result.status, 200);
    assert.equal(result.body.dataset.publishedCvCount, 1);
    assert.deepEqual(result.body.attributes, []);
    assert.equal(prisma.calls.profileValueFindMany.length, 0);
  });
});

test("aggregates finite numeric values and returns nulls for an unfilled numeric attribute", async () => {
  const users = ["user-1", "user-2", "user-3", "user-4"];
  const { app } = createTestApp({
    prisma: {
      positionAttributes: [
        createPositionAttribute({ id: 1, attributeId: 1, type: "NUMERIC" }),
        createPositionAttribute({ id: 2, attributeId: 2, type: "NUMERIC" }),
      ],
      cvs: users.map((userId) => createCv(userId)),
      profileValues: [
        createProfileValue("user-1", 1, { numericValue: 6 }),
        createProfileValue("user-2", 1, { numericValue: 7.5 }),
        createProfileValue("user-3", 1, { numericValue: 9 }),
        createProfileValue("user-4", 1, { numericValue: Infinity }),
      ],
    },
  });

  await withServer(app, async (baseUrl) => {
    const result = await request(baseUrl, "/api/integrations/odoo/position");

    assert.deepEqual(getAttribute(result.body, 1).statistics, {
      kind: "NUMERIC",
      filledCount: 3,
      missingCount: 1,
      average: 7.5,
      min: 6,
      max: 9,
    });
    assert.deepEqual(getAttribute(result.body, 2).statistics, {
      kind: "NUMERIC",
      filledCount: 0,
      missingCount: 4,
      average: null,
      min: null,
      max: null,
    });
  });
});

test("computes a finite numeric average when finite values would overflow a direct sum", async () => {
  const users = ["user-1", "user-2"];
  const { app } = createTestApp({
    prisma: {
      positionAttributes: [
        createPositionAttribute({ id: 1, attributeId: 1, type: "NUMERIC" }),
      ],
      cvs: users.map((userId) => createCv(userId)),
      profileValues: users.map((userId) =>
        createProfileValue(userId, 1, { numericValue: Number.MAX_VALUE }),
      ),
    },
  });

  assert.equal(Number.MAX_VALUE + Number.MAX_VALUE, Infinity);

  await withServer(app, async (baseUrl) => {
    const result = await request(baseUrl, "/api/integrations/odoo/position");
    const statistics = getAttribute(result.body, 1).statistics;

    assert.equal(result.status, 200);
    assert.equal(statistics.kind, "NUMERIC");
    assert.equal(statistics.filledCount, 2);
    assert.equal(statistics.missingCount, 0);
    assert.equal(typeof statistics.average, "number");
    assert.equal(Number.isFinite(statistics.average), true);
    assert.equal(Number.isNaN(statistics.average), false);
    assert.notEqual(statistics.average, Infinity);
    assert.notEqual(statistics.average, null);
    assert.equal(statistics.average, Number.MAX_VALUE);
    assert.equal(statistics.min, Number.MAX_VALUE);
    assert.equal(statistics.max, Number.MAX_VALUE);
  });
});

test("preserves a positive finite subnormal numeric average", async () => {
  const users = ["user-1", "user-2"];
  const { app } = createTestApp({
    prisma: {
      positionAttributes: [
        createPositionAttribute({ id: 1, attributeId: 1, type: "NUMERIC" }),
      ],
      cvs: users.map((userId) => createCv(userId)),
      profileValues: users.map((userId) =>
        createProfileValue(userId, 1, { numericValue: Number.MIN_VALUE }),
      ),
    },
  });

  assert.equal(Number.MIN_VALUE / 2, 0);

  await withServer(app, async (baseUrl) => {
    const result = await request(baseUrl, "/api/integrations/odoo/position");
    const statistics = getAttribute(result.body, 1).statistics;

    assert.equal(result.status, 200);
    assert.equal(statistics.kind, "NUMERIC");
    assert.equal(statistics.filledCount, 2);
    assert.equal(statistics.missingCount, 0);
    assert.equal(typeof statistics.average, "number");
    assert.equal(Number.isFinite(statistics.average), true);
    assert.equal(statistics.average, Number.MIN_VALUE);
    assert.notEqual(statistics.average, 0);
    assert.equal(statistics.min, Number.MIN_VALUE);
    assert.equal(statistics.max, Number.MIN_VALUE);
    assert.equal(statistics.min <= statistics.average, true);
    assert.equal(statistics.average <= statistics.max, true);
  });
});

test("preserves a negative finite subnormal numeric average", async () => {
  const users = ["user-1", "user-2"];
  const { app } = createTestApp({
    prisma: {
      positionAttributes: [
        createPositionAttribute({ id: 1, attributeId: 1, type: "NUMERIC" }),
      ],
      cvs: users.map((userId) => createCv(userId)),
      profileValues: users.map((userId) =>
        createProfileValue(userId, 1, { numericValue: -Number.MIN_VALUE }),
      ),
    },
  });

  await withServer(app, async (baseUrl) => {
    const result = await request(baseUrl, "/api/integrations/odoo/position");
    const statistics = getAttribute(result.body, 1).statistics;

    assert.equal(result.status, 200);
    assert.equal(statistics.kind, "NUMERIC");
    assert.equal(statistics.filledCount, 2);
    assert.equal(statistics.missingCount, 0);
    assert.equal(typeof statistics.average, "number");
    assert.equal(Number.isFinite(statistics.average), true);
    assert.equal(statistics.average, -Number.MIN_VALUE);
    assert.equal(Object.is(statistics.average, -0), false);
    assert.equal(statistics.min, -Number.MIN_VALUE);
    assert.equal(statistics.max, -Number.MIN_VALUE);
    assert.equal(statistics.min <= statistics.average, true);
    assert.equal(statistics.average <= statistics.max, true);
  });
});

test("counts booleans while treating false as filled", async () => {
  const users = ["user-1", "user-2", "user-3", "user-4"];
  const { app } = createTestApp({
    prisma: {
      positionAttributes: [
        createPositionAttribute({ id: 1, attributeId: 1, type: "BOOLEAN" }),
      ],
      cvs: users.map((userId) => createCv(userId)),
      profileValues: [
        createProfileValue("user-1", 1, { booleanValue: true }),
        createProfileValue("user-2", 1, { booleanValue: true }),
        createProfileValue("user-3", 1, { booleanValue: false }),
        createProfileValue("user-4", 1),
      ],
    },
  });

  await withServer(app, async (baseUrl) => {
    const result = await request(baseUrl, "/api/integrations/odoo/position");

    assert.deepEqual(getAttribute(result.body, 1).statistics, {
      kind: "BOOLEAN",
      filledCount: 3,
      missingCount: 1,
      trueCount: 2,
      falseCount: 1,
    });
  });
});

test("groups STRING and SELECT values while returning TEXT completeness", async () => {
  const users = Array.from({ length: 10 }, (_, index) => `user-${index + 1}`);
  const privateText = [
    "PRIVATE_TEXT_MARKER_7f31",
    "[Private portfolio](https://private.example/profile)",
    "Contact: private.candidate@example.test",
  ].join("\n");
  const stringValues = [
    "Beta",
    "Alpha",
    "Beta",
    "Alpha",
    "Charlie",
    "Delta",
    "Echo",
    "Foxtrot",
    "   ",
    null,
  ];
  const { app, prisma } = createTestApp({
    prisma: {
      positionAttributes: [
        createPositionAttribute({ id: 1, attributeId: 1, type: "STRING" }),
        createPositionAttribute({ id: 2, attributeId: 2, type: "SELECT" }),
        createPositionAttribute({ id: 3, attributeId: 3, type: "TEXT" }),
      ],
      cvs: users.map((userId) => createCv(userId)),
      profileValues: [
        ...users.map((userId, index) =>
          createProfileValue(userId, 1, {
            stringValue: stringValues[index],
          }),
        ),
        createProfileValue("user-1", 2, { stringValue: "Advanced" }),
        createProfileValue("user-2", 2, { stringValue: "Advanced" }),
        createProfileValue("user-3", 2, { stringValue: "Intermediate" }),
        createProfileValue("user-4", 2, { stringValue: " " }),
        createProfileValue("user-1", 3, { textValue: privateText }),
        createProfileValue("user-2", 3, { textValue: "Filled summary" }),
        createProfileValue("user-3", 3, { textValue: null }),
        createProfileValue("user-4", 3, { textValue: "" }),
        createProfileValue("user-5", 3, { textValue: "   " }),
      ],
    },
  });

  await withServer(app, async (baseUrl) => {
    const result = await request(baseUrl, "/api/integrations/odoo/position");

    assert.deepEqual(getAttribute(result.body, 1).statistics, {
      kind: "POPULAR_VALUES",
      filledCount: 8,
      missingCount: 2,
      topValues: [
        { value: "Alpha", count: 2 },
        { value: "Beta", count: 2 },
        { value: "Charlie", count: 1 },
        { value: "Delta", count: 1 },
        { value: "Echo", count: 1 },
      ],
    });
    assert.equal(getAttribute(result.body, 1).statistics.topValues.length, 5);
    assert.deepEqual(getAttribute(result.body, 2).statistics, {
      kind: "POPULAR_VALUES",
      filledCount: 3,
      missingCount: 7,
      topValues: [
        { value: "Advanced", count: 2 },
        { value: "Intermediate", count: 1 },
      ],
    });
    assert.deepEqual(getAttribute(result.body, 3).statistics, {
      kind: "COMPLETENESS",
      filledCount: 2,
      missingCount: 8,
    });
    const serializedBody = JSON.stringify(result.body);
    const textStatistics = getAttribute(result.body, 3).statistics;

    assert.equal(serializedBody.includes("PRIVATE_TEXT_MARKER_7f31"), false);
    assert.equal(serializedBody.includes("https://private.example/profile"), false);
    assert.equal(serializedBody.includes("private.candidate@example.test"), false);
    assert.equal(serializedBody.includes("Filled summary"), false);
    assert.equal(Object.hasOwn(textStatistics, "topValues"), false);
    assert.equal(Object.hasOwn(textStatistics, "value"), false);
    assert.equal(serializedBody.includes("user-1"), false);
    assert.equal(serializedBody.includes("userId"), false);
    assert.equal(
      Object.hasOwn(
        prisma.calls.profileValueFindMany[0].select,
        "textValue",
      ),
      false,
    );
    assert.deepEqual(prisma.calls.profileValueFindMany[0].where.attributeId, {
      in: [1, 2],
    });
    assert.equal(prisma.calls.textCompletenessQueries.length, 1);
    assert.match(
      prisma.calls.textCompletenessQueries[0].text,
      /SELECT "attributeId", COUNT\(\*\)::integer AS "filledCount"/,
    );
    assert.match(
      prisma.calls.textCompletenessQueries[0].text,
      /btrim\("textValue"\) <> ''/,
    );
    assert.deepEqual(prisma.calls.textCompletenessQueries[0].values, [
      ...users,
      3,
    ]);
    assert.deepEqual(prisma.calls.textCompletenessResults, [
      [{ attributeId: 3, filledCount: 2 }],
    ]);
    assert.deepEqual(
      Object.keys(prisma.calls.textCompletenessResults[0][0]).sort(),
      ["attributeId", "filledCount"],
    );
  });
});

test("aggregates dates and complete periods while hiding image URLs", async () => {
  const users = ["user-1", "user-2", "user-3"];
  const { app } = createTestApp({
    prisma: {
      positionAttributes: [
        createPositionAttribute({ id: 1, attributeId: 1, type: "DATE" }),
        createPositionAttribute({ id: 2, attributeId: 2, type: "PERIOD" }),
        createPositionAttribute({ id: 3, attributeId: 3, type: "IMAGE" }),
      ],
      cvs: users.map((userId) => createCv(userId)),
      profileValues: [
        createProfileValue("user-1", 1, {
          dateValue: new Date("2025-01-01T00:00:00.000Z"),
        }),
        createProfileValue("user-2", 1, {
          dateValue: new Date("2026-01-01T00:00:00.000Z"),
        }),
        createProfileValue("user-3", 1, { dateValue: "invalid" }),
        createProfileValue("user-1", 2, {
          periodStart: new Date("2024-01-01T00:00:00.000Z"),
          periodEnd: new Date("2025-01-01T00:00:00.000Z"),
        }),
        createProfileValue("user-2", 2, {
          periodStart: new Date("2024-06-01T00:00:00.000Z"),
        }),
        createProfileValue("user-3", 2, {
          periodStart: new Date("2025-01-01T00:00:00.000Z"),
          periodEnd: new Date("2026-01-01T00:00:00.000Z"),
        }),
        createProfileValue("user-1", 3, {
          imageUrl: "https://private.example/image.png",
        }),
        createProfileValue("user-2", 3, { imageUrl: "   " }),
      ],
    },
  });

  await withServer(app, async (baseUrl) => {
    const result = await request(baseUrl, "/api/integrations/odoo/position");

    assert.deepEqual(getAttribute(result.body, 1).statistics, {
      kind: "DATE_RANGE",
      filledCount: 2,
      missingCount: 1,
      earliest: "2025-01-01T00:00:00.000Z",
      latest: "2026-01-01T00:00:00.000Z",
    });
    assert.deepEqual(getAttribute(result.body, 2).statistics, {
      kind: "PERIOD_RANGE",
      filledCount: 2,
      missingCount: 1,
      earliestStart: "2024-01-01T00:00:00.000Z",
      latestEnd: "2026-01-01T00:00:00.000Z",
    });
    assert.deepEqual(getAttribute(result.body, 3).statistics, {
      kind: "COMPLETENESS",
      filledCount: 1,
      missingCount: 2,
    });
    assert.equal(
      JSON.stringify(result.body).includes("https://private.example/image.png"),
      false,
    );
  });
});

test("uses safe completeness statistics for an unknown future attribute type", async () => {
  const { app } = createTestApp({
    prisma: {
      positionAttributes: [
        createPositionAttribute({ id: 1, attributeId: 1, type: "FUTURE" }),
      ],
      cvs: [createCv("user-1"), createCv("user-2")],
      profileValues: [
        createProfileValue("user-1", 1, { stringValue: "Filled" }),
        createProfileValue("user-2", 1),
      ],
    },
  });

  await withServer(app, async (baseUrl) => {
    const result = await request(baseUrl, "/api/integrations/odoo/position");

    assert.deepEqual(getAttribute(result.body, 1).statistics, {
      kind: "COMPLETENESS",
      filledCount: 1,
      missingCount: 1,
    });
  });
});

test("returns a generic 500 and logs only sanitized metadata", async () => {
  const internalError = new Error(
    `internal ${RAW_TOKEN} ${TOKEN_HASH} PositionOdooToken`,
  );
  internalError.name = `Unsafe-${RAW_TOKEN}`;
  internalError.code = TOKEN_HASH;
  const { app } = createTestApp({
    prisma: {
      errors: {
        tokenFindUnique: internalError,
      },
    },
  });
  const originalConsoleError = console.error;
  const consoleCalls = [];
  console.error = (...args) => consoleCalls.push(args);

  try {
    await withServer(app, async (baseUrl) => {
      const result = await request(baseUrl, "/api/integrations/odoo/position");

      assert.equal(result.status, 500);
      assert.deepEqual(result.body, {
        message: "Failed to load Odoo position results",
      });
      assert.equal(result.headers["cache-control"], "no-store");
      assert.equal(JSON.stringify(result.body).includes("internal"), false);
      assert.equal(JSON.stringify(result.body).includes("PositionOdooToken"), false);
    });
  } finally {
    console.error = originalConsoleError;
  }

  const consoleOutput = JSON.stringify(consoleCalls);
  assert.equal(consoleOutput.includes(RAW_TOKEN), false);
  assert.equal(consoleOutput.includes(TOKEN_HASH), false);
  assert.equal(consoleOutput.includes("internal"), false);
  assert.equal(consoleOutput.includes("PositionOdooToken"), false);
});

test("recursive secret checker traverses nested objects and arrays", () => {
  assert.doesNotThrow(() =>
    assertNoForbiddenKeys({
      attributes: [{ statistics: { topValues: [{ value: "Safe", count: 1 }] } }],
    }),
  );
  assert.throws(
    () => assertNoForbiddenKeys([{ nested: { tokenHash: "secret" } }]),
    /Unexpected key: tokenHash/,
  );
});
