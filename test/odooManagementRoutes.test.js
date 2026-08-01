const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const {
  createOdooManagementRouter,
} = require("../src/routes/odooManagementRoutes");

const POSITION_ID = 8;
const FAKE_RAW_TOKEN = "cvms_odoo_fake_management_token_1";
const SECOND_FAKE_RAW_TOKEN = "cvms_odoo_fake_management_token_2";
const FAKE_TOKEN_HASH = "fake-token-hash-1";
const SECOND_FAKE_TOKEN_HASH = "fake-token-hash-2";
const FAKE_TOKEN_HINT = "...token_1";
const SECOND_FAKE_TOKEN_HINT = "...token_2";
const CREATED_AT = new Date("2026-07-31T10:00:00.000Z");
const UPDATED_AT = new Date("2026-07-31T11:00:00.000Z");

function createUser(id, role, status = "ACTIVE") {
  return {
    id,
    name: `${role} User`,
    email: `${role.toLowerCase()}@test.com`,
    status,
    roles: [{ role: { name: role } }],
  };
}

function createPrismaError(code, message = "Prisma operation failed") {
  const error = new Error(message);
  error.name = "PrismaClientKnownRequestError";
  error.code = code;
  return error;
}

function applySelect(record, select) {
  if (!record || !select) {
    return record;
  }

  return Object.fromEntries(
    Object.entries(select)
      .filter(([, included]) => included)
      .map(([key]) => [key, record[key]]),
  );
}

function createTokenRecord(overrides = {}) {
  return {
    id: "token-1",
    positionId: POSITION_ID,
    tokenHash: "stored-token-hash",
    tokenHint: "...stored01",
    version: 1,
    revokedAt: null,
    createdById: "recruiter-1",
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function createMockPrisma(options = {}) {
  const users = new Map([
    ["candidate-1", createUser("candidate-1", "CANDIDATE")],
    ["recruiter-1", createUser("recruiter-1", "RECRUITER")],
    ["admin-1", createUser("admin-1", "ADMIN")],
    ["blocked-1", createUser("blocked-1", "RECRUITER", "BLOCKED")],
  ]);

  const positions = new Set(options.positions || [POSITION_ID]);
  const state = {
    token: options.token ? { ...options.token } : null,
  };
  const calls = {
    userFindUnique: [],
    positionFindUnique: [],
    tokenFindUnique: [],
    tokenCreate: [],
    tokenUpdate: [],
  };
  const errors = options.errors || {};

  const prismaClient = {
    user: {
      async findUnique(args) {
        calls.userFindUnique.push(args);

        if (errors.userFindUnique) {
          throw errors.userFindUnique;
        }

        return users.get(args.where.id) || null;
      },
    },
    position: {
      async findUnique(args) {
        calls.positionFindUnique.push(args);

        if (errors.positionFindUnique) {
          throw errors.positionFindUnique;
        }

        return positions.has(args.where.id) ? { id: args.where.id } : null;
      },
    },
    positionOdooToken: {
      async findUnique(args) {
        calls.tokenFindUnique.push(args);

        if (errors.tokenFindUnique) {
          throw errors.tokenFindUnique;
        }

        if (!state.token || state.token.positionId !== args.where.positionId) {
          return null;
        }

        return applySelect(state.token, args.select);
      },
      async create(args) {
        calls.tokenCreate.push(args);

        if (errors.tokenCreate) {
          throw errors.tokenCreate;
        }

        state.token = {
          id: "created-token",
          ...args.data,
          version: 1,
          revokedAt: null,
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
        };

        return applySelect(state.token, args.select);
      },
      async update(args) {
        calls.tokenUpdate.push(args);

        if (errors.tokenUpdate) {
          throw errors.tokenUpdate;
        }

        if (
          !state.token ||
          state.token.positionId !== args.where.positionId ||
          state.token.version !== args.where.version
        ) {
          throw createPrismaError("P2025");
        }

        const data = args.data;

        if (Object.prototype.hasOwnProperty.call(data, "tokenHash")) {
          state.token.tokenHash = data.tokenHash;
        }

        if (Object.prototype.hasOwnProperty.call(data, "tokenHint")) {
          state.token.tokenHint = data.tokenHint;
        }

        if (Object.prototype.hasOwnProperty.call(data, "revokedAt")) {
          state.token.revokedAt = data.revokedAt;
        }

        if (data.version?.increment) {
          state.token.version += data.version.increment;
        }

        state.token.updatedAt = new Date("2026-07-31T12:00:00.000Z");

        return applySelect(state.token, args.select);
      },
    },
  };

  return {
    calls,
    prismaClient,
    state,
  };
}

function createMockTokenService(rawTokens = [FAKE_RAW_TOKEN]) {
  let tokenIndex = 0;
  const calls = {
    createTokenHint: [],
    generateRawToken: 0,
    hashToken: [],
  };

  return {
    calls,
    tokenService: {
      generateRawToken() {
        calls.generateRawToken += 1;
        const token = rawTokens[Math.min(tokenIndex, rawTokens.length - 1)];
        tokenIndex += 1;
        return token;
      },
      hashToken(rawToken) {
        calls.hashToken.push(rawToken);
        return rawToken === SECOND_FAKE_RAW_TOKEN
          ? SECOND_FAKE_TOKEN_HASH
          : FAKE_TOKEN_HASH;
      },
      createTokenHint(rawToken) {
        calls.createTokenHint.push(rawToken);
        return rawToken === SECOND_FAKE_RAW_TOKEN
          ? SECOND_FAKE_TOKEN_HINT
          : FAKE_TOKEN_HINT;
      },
    },
  };
}

function createTestApp(options = {}) {
  const prisma = createMockPrisma(options.prisma);
  const tokenService = createMockTokenService(options.rawTokens);
  const app = express();

  app.use(express.json());
  app.use(
    "/api/positions",
    createOdooManagementRouter({
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
}

async function request(baseUrl, path, options = {}) {
  const headers = {};

  if (options.userId !== null) {
    headers["x-dev-user-id"] = options.userId || "recruiter-1";
  }

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers,
    body:
      options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const responseBody = await response.json();

  assertNoForbiddenKeys(responseBody, ["tokenHash"]);

  if ((options.method || "GET") !== "POST" || !response.ok) {
    assertNoForbiddenKeys(responseBody, ["rawToken"]);
  }

  return {
    body: responseBody,
    response,
  };
}

function assertNoForbiddenKeys(value, forbiddenKeys) {
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

test("enforces authentication, roles, position validation, and position existence", async () => {
  const { app } = createTestApp();

  await withServer(app, async (baseUrl) => {
    const invalidId = await request(baseUrl, "/api/positions/invalid/odoo-token");
    assert.equal(invalidId.response.status, 400);
    assert.deepEqual(invalidId.body, {
      message: "Valid position id is required",
    });

    const missingHeader = await request(
      baseUrl,
      `/api/positions/${POSITION_ID}/odoo-token`,
      { userId: null },
    );
    assert.equal(missingHeader.response.status, 401);

    const unknownUser = await request(
      baseUrl,
      `/api/positions/${POSITION_ID}/odoo-token`,
      { userId: "unknown-user" },
    );
    assert.equal(unknownUser.response.status, 401);

    const blockedUser = await request(
      baseUrl,
      `/api/positions/${POSITION_ID}/odoo-token`,
      { userId: "blocked-1" },
    );
    assert.equal(blockedUser.response.status, 403);

    const candidate = await request(
      baseUrl,
      `/api/positions/${POSITION_ID}/odoo-token`,
      { userId: "candidate-1" },
    );
    assert.equal(candidate.response.status, 403);

    const recruiter = await request(
      baseUrl,
      `/api/positions/${POSITION_ID}/odoo-token`,
    );
    assert.equal(recruiter.response.status, 200);

    const admin = await request(
      baseUrl,
      `/api/positions/${POSITION_ID}/odoo-token`,
      { userId: "admin-1" },
    );
    assert.equal(admin.response.status, 200);

    const unknownPosition = await request(
      baseUrl,
      "/api/positions/999/odoo-token",
    );
    assert.equal(unknownPosition.response.status, 404);
    assert.deepEqual(unknownPosition.body, {
      message: "Position not found",
    });
  });
});

test("returns null when a position has no Odoo token", async () => {
  const { app } = createTestApp();

  await withServer(app, async (baseUrl) => {
    const result = await request(
      baseUrl,
      `/api/positions/${POSITION_ID}/odoo-token`,
    );

    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body, {
      positionId: POSITION_ID,
      token: null,
    });
    assertNoForbiddenKeys(result.body, ["rawToken", "tokenHash"]);
  });
});

test("returns an allowlisted ACTIVE token status without secrets", async () => {
  const token = createTokenRecord();
  const { app } = createTestApp({ prisma: { token } });

  await withServer(app, async (baseUrl) => {
    const result = await request(
      baseUrl,
      `/api/positions/${POSITION_ID}/odoo-token`,
    );

    assert.equal(result.response.status, 200);
    assert.equal(result.body.token.status, "ACTIVE");
    assert.equal(result.body.token.hint, token.tokenHint);
    assert.equal(result.body.token.version, token.version);
    assertNoForbiddenKeys(result.body, ["rawToken", "tokenHash"]);
    assert.equal(JSON.stringify(result.body).includes(token.tokenHash), false);
  });
});

test("returns a REVOKED token status without secrets", async () => {
  const token = createTokenRecord({
    revokedAt: new Date("2026-07-31T11:30:00.000Z"),
  });
  const { app } = createTestApp({ prisma: { token } });

  await withServer(app, async (baseUrl) => {
    const result = await request(
      baseUrl,
      `/api/positions/${POSITION_ID}/odoo-token`,
    );

    assert.equal(result.response.status, 200);
    assert.equal(result.body.token.status, "REVOKED");
    assertNoForbiddenKeys(result.body, ["rawToken", "tokenHash"]);
  });
});

test("creates a token using only its hash and returns rawToken once", async () => {
  const { app, prisma, tokenService } = createTestApp();

  await withServer(app, async (baseUrl) => {
    const created = await request(
      baseUrl,
      `/api/positions/${POSITION_ID}/odoo-token`,
      {
        method: "POST",
        body: {},
      },
    );

    assert.equal(created.response.status, 201);
    assert.equal(created.response.headers.get("cache-control"), "no-store");
    assert.equal(created.body.rawToken, FAKE_RAW_TOKEN);
    assert.equal(created.body.token.status, "ACTIVE");
    assert.equal(created.body.token.version, 1);
    assertNoForbiddenKeys(created.body, ["tokenHash"]);

    assert.equal(prisma.calls.tokenCreate.length, 1);
    assert.deepEqual(prisma.calls.tokenCreate[0].data, {
      positionId: POSITION_ID,
      tokenHash: FAKE_TOKEN_HASH,
      tokenHint: FAKE_TOKEN_HINT,
      createdById: "recruiter-1",
    });
    assert.equal(
      JSON.stringify(prisma.calls.tokenCreate[0].data).includes(FAKE_RAW_TOKEN),
      false,
    );
    assert.equal(prisma.state.token.tokenHash, FAKE_TOKEN_HASH);
    assert.equal(tokenService.calls.generateRawToken, 1);

    const status = await request(
      baseUrl,
      `/api/positions/${POSITION_ID}/odoo-token`,
    );
    assertNoForbiddenKeys(status.body, ["rawToken", "tokenHash"]);
  });
});

test("maps a concurrent P2002 create conflict to 409", async () => {
  const { app } = createTestApp({
    prisma: {
      errors: {
        tokenCreate: createPrismaError("P2002"),
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const result = await request(
      baseUrl,
      `/api/positions/${POSITION_ID}/odoo-token`,
      { method: "POST", body: {} },
    );

    assert.equal(result.response.status, 409);
    assert.deepEqual(result.body, {
      message: "Odoo token already exists",
    });
    assertNoForbiddenKeys(result.body, ["rawToken", "tokenHash"]);
  });
});

test("does not create a missing token when the request contains version", async () => {
  const { app, prisma, tokenService } = createTestApp();

  await withServer(app, async (baseUrl) => {
    const result = await request(
      baseUrl,
      `/api/positions/${POSITION_ID}/odoo-token`,
      { method: "POST", body: { version: 1 } },
    );

    assert.equal(result.response.status, 409);
    assert.deepEqual(result.body, {
      message: "Odoo token version conflict",
    });
    assert.equal(prisma.calls.tokenCreate.length, 0);
    assert.equal(tokenService.calls.generateRawToken, 0);
  });
});

test("requires a positive integer version to regenerate an existing token", async () => {
  const token = createTokenRecord({ version: 2 });
  const { app, tokenService } = createTestApp({ prisma: { token } });

  await withServer(app, async (baseUrl) => {
    for (const body of [{}, { version: 0 }, { version: -1 }, { version: 1.5 }]) {
      const result = await request(
        baseUrl,
        `/api/positions/${POSITION_ID}/odoo-token`,
        { method: "POST", body },
      );

      assert.equal(result.response.status, 400);
      assert.deepEqual(result.body, {
        message: "Valid version is required",
      });
    }

    assert.equal(tokenService.calls.generateRawToken, 0);
  });
});

test("regenerates atomically, reactivates the token, and preserves createdById", async () => {
  const token = createTokenRecord({
    version: 2,
    revokedAt: new Date("2026-07-31T11:30:00.000Z"),
    createdById: "admin-1",
  });
  const { app, prisma } = createTestApp({
    prisma: { token },
    rawTokens: [SECOND_FAKE_RAW_TOKEN],
  });

  await withServer(app, async (baseUrl) => {
    const result = await request(
      baseUrl,
      `/api/positions/${POSITION_ID}/odoo-token`,
      { method: "POST", body: { version: 2 } },
    );

    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    assert.equal(result.body.rawToken, SECOND_FAKE_RAW_TOKEN);
    assert.equal(result.body.token.status, "ACTIVE");
    assert.equal(result.body.token.version, 3);
    assert.equal(result.body.token.hint, SECOND_FAKE_TOKEN_HINT);
    assertNoForbiddenKeys(result.body, ["tokenHash"]);

    assert.equal(prisma.calls.tokenUpdate.length, 1);
    assert.deepEqual(prisma.calls.tokenUpdate[0].where, {
      positionId: POSITION_ID,
      version: 2,
    });
    assert.deepEqual(prisma.calls.tokenUpdate[0].data, {
      tokenHash: SECOND_FAKE_TOKEN_HASH,
      tokenHint: SECOND_FAKE_TOKEN_HINT,
      revokedAt: null,
      version: {
        increment: 1,
      },
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        prisma.calls.tokenUpdate[0].data,
        "createdById",
      ),
      false,
    );
    assert.equal(prisma.state.token.createdById, "admin-1");
    assert.equal(prisma.state.token.tokenHash, SECOND_FAKE_TOKEN_HASH);
    assert.equal(prisma.state.token.revokedAt, null);

    const status = await request(
      baseUrl,
      `/api/positions/${POSITION_ID}/odoo-token`,
    );
    assertNoForbiddenKeys(status.body, ["rawToken", "tokenHash"]);
  });
});

test("maps a stale regeneration version to 409", async () => {
  const token = createTokenRecord({ version: 2 });
  const { app } = createTestApp({ prisma: { token } });

  await withServer(app, async (baseUrl) => {
    const result = await request(
      baseUrl,
      `/api/positions/${POSITION_ID}/odoo-token`,
      { method: "POST", body: { version: 1 } },
    );

    assert.equal(result.response.status, 409);
    assert.deepEqual(result.body, {
      message: "Odoo token version conflict",
    });
    assertNoForbiddenKeys(result.body, ["rawToken", "tokenHash"]);
  });
});

test("requires a positive integer version to revoke", async () => {
  const token = createTokenRecord({ version: 2 });
  const { app } = createTestApp({ prisma: { token } });

  await withServer(app, async (baseUrl) => {
    for (const body of [{}, { version: 0 }, { version: -1 }, { version: 1.5 }]) {
      const result = await request(
        baseUrl,
        `/api/positions/${POSITION_ID}/odoo-token/revoke`,
        { method: "PATCH", body },
      );

      assert.equal(result.response.status, 400);
      assert.deepEqual(result.body, {
        message: "Valid version is required",
      });
    }
  });
});

test("returns 404 when revoking a missing token", async () => {
  const { app } = createTestApp();

  await withServer(app, async (baseUrl) => {
    const result = await request(
      baseUrl,
      `/api/positions/${POSITION_ID}/odoo-token/revoke`,
      { method: "PATCH", body: { version: 1 } },
    );

    assert.equal(result.response.status, 404);
    assert.deepEqual(result.body, {
      message: "Odoo token not found",
    });
  });
});

test("revokes atomically without changing tokenHash or tokenHint", async () => {
  const token = createTokenRecord({ version: 2 });
  const originalHash = token.tokenHash;
  const originalHint = token.tokenHint;
  const { app, prisma } = createTestApp({ prisma: { token } });

  await withServer(app, async (baseUrl) => {
    const result = await request(
      baseUrl,
      `/api/positions/${POSITION_ID}/odoo-token/revoke`,
      { method: "PATCH", body: { version: 2 } },
    );

    assert.equal(result.response.status, 200);
    assert.equal(result.body.token.status, "REVOKED");
    assert.equal(result.body.token.version, 3);
    assert.notEqual(result.body.token.revokedAt, null);
    assertNoForbiddenKeys(result.body, ["rawToken", "tokenHash"]);

    assert.deepEqual(prisma.calls.tokenUpdate[0].where, {
      positionId: POSITION_ID,
      version: 2,
    });
    assert.equal(prisma.calls.tokenUpdate[0].data.revokedAt instanceof Date, true);
    assert.deepEqual(prisma.calls.tokenUpdate[0].data.version, {
      increment: 1,
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        prisma.calls.tokenUpdate[0].data,
        "tokenHash",
      ),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        prisma.calls.tokenUpdate[0].data,
        "tokenHint",
      ),
      false,
    );
    assert.equal(prisma.state.token.tokenHash, originalHash);
    assert.equal(prisma.state.token.tokenHint, originalHint);
  });
});

test("maps a stale revoke version or P2025 to 409", async () => {
  const token = createTokenRecord({ version: 2 });
  const { app } = createTestApp({ prisma: { token } });

  await withServer(app, async (baseUrl) => {
    const result = await request(
      baseUrl,
      `/api/positions/${POSITION_ID}/odoo-token/revoke`,
      { method: "PATCH", body: { version: 1 } },
    );

    assert.equal(result.response.status, 409);
    assert.deepEqual(result.body, {
      message: "Odoo token version conflict",
    });
    assertNoForbiddenKeys(result.body, ["rawToken", "tokenHash"]);
  });
});

test("returns a generic 500 and logs only safe error metadata", async () => {
  const internalError = new Error(
    `internal ${FAKE_RAW_TOKEN} ${FAKE_TOKEN_HASH}`,
  );
  internalError.name = `Unsafe-${FAKE_RAW_TOKEN}`;
  const { app } = createTestApp({
    prisma: {
      errors: {
        tokenFindUnique: internalError,
      },
    },
  });
  const originalConsoleError = console.error;
  const consoleCalls = [];
  console.error = (...args) => {
    consoleCalls.push(args);
  };

  try {
    await withServer(app, async (baseUrl) => {
      const result = await request(
        baseUrl,
        `/api/positions/${POSITION_ID}/odoo-token`,
      );

      assert.equal(result.response.status, 500);
      assert.deepEqual(result.body, {
        message: "Failed to manage Odoo token",
      });
      assertNoForbiddenKeys(result.body, ["rawToken", "tokenHash"]);
      assert.equal(JSON.stringify(result.body).includes("internal"), false);
    });
  } finally {
    console.error = originalConsoleError;
  }

  const consoleOutput = JSON.stringify(consoleCalls);
  assert.equal(consoleOutput.includes(FAKE_RAW_TOKEN), false);
  assert.equal(consoleOutput.includes(FAKE_TOKEN_HASH), false);
  assert.equal(consoleOutput.includes("internal"), false);
});
