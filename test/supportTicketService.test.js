const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MAX_SUMMARY_LENGTH,
  SupportTicketError,
  buildSupportTicketFilename,
  createSupportTicketService,
} = require("../src/services/supportTicketService");
const {
  OneDriveGraphError,
} = require("../src/integrations/oneDriveGraphClient");

const FIXED_DATE = new Date("2026-08-03T12:05:01.123Z");
const FIXED_UUID = "550e8400-e29b-41d4-a716-446655440000";
const ALLOWED_ORIGIN = "https://course-project-client-one.vercel.app";
const BASE_BODY = {
  summary: "  Cannot publish my CV  ",
  priority: "High",
  positionId: 123,
  link: `${ALLOWED_ORIGIN}/cvs/7?from=my-cvs#attributes`,
};

function createUser({
  id,
  roles = ["CANDIDATE"],
  status = "ACTIVE",
  email,
  name,
}) {
  return {
    id,
    name: name || `${roles[0]} User`,
    email: email === undefined ? `${id}@example.com` : email,
    status,
    passwordHash: "PRIVATE_PASSWORD_HASH",
    roles: roles.map((roleName) => ({
      role: {
        name: roleName,
        internalSecret: "PRIVATE_ROLE_SECRET",
      },
    })),
  };
}

function createPrismaFixture({ currentUser, users = [], position = null }) {
  const calls = [];
  const allUsers = [currentUser, ...users].filter(Boolean);

  return {
    calls,
    client: {
      user: {
        async findUnique(args) {
          calls.push({ model: "user", operation: "findUnique", args });
          return allUsers.find((user) => user.id === args.where.id) || null;
        },
        async findMany(args) {
          calls.push({ model: "user", operation: "findMany", args });

          return allUsers
            .filter(
              (user) =>
                user.status === "ACTIVE" &&
                user.roles.some(({ role }) => role.name === "ADMIN"),
            )
            .map(({ email: adminEmail }) => ({ email: adminEmail }));
        },
      },
      position: {
        async findUnique(args) {
          calls.push({ model: "position", operation: "findUnique", args });

          if (!position || position.id !== args.where.id) {
            return null;
          }

          return {
            id: position.id,
            title: position.title,
          };
        },
      },
    },
  };
}

function createFixture(options = {}) {
  const currentUser =
    options.currentUser || createUser({ id: "candidate-1" });
  const admins =
    options.admins === undefined
      ? [createUser({ id: "admin-1", roles: ["ADMIN"] })]
      : options.admins;
  const prisma = createPrismaFixture({
    currentUser,
    users: admins,
    position:
      options.position === undefined
        ? { id: 123, title: "Frontend Developer" }
        : options.position,
  });
  const uploads = [];
  const accessTokenCalls = [];

  const service = createSupportTicketService({
    prismaClient: prisma.client,
    allowedOrigins: options.allowedOrigins || [ALLOWED_ORIGIN],
    driveId: options.driveId === undefined ? "drive-1" : options.driveId,
    folderPath:
      options.folderPath === undefined
        ? "support-tickets"
        : options.folderPath,
    now: () => FIXED_DATE,
    randomUUID: () => FIXED_UUID,
    getAccessToken:
      options.getAccessToken ||
      (async (args) => {
        accessTokenCalls.push(args);
        return "internal-access-token";
      }),
    uploadJson:
      options.uploadJson ||
      (async (args) => {
        uploads.push(args);
        return { uploaded: true };
      }),
  });

  return {
    accessTokenCalls,
    currentUser,
    prisma,
    service,
    uploads,
  };
}

async function expectServiceError(promise, statusCode, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof SupportTicketError);
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.code, code);
    return true;
  });
}

test("requires x-dev-user-id before database or upload work", async () => {
  const fixture = createFixture();

  await expectServiceError(
    fixture.service.submit({ body: BASE_BODY }),
    401,
    "AUTHENTICATION_REQUIRED",
  );

  assert.equal(fixture.prisma.calls.length, 0);
  assert.equal(fixture.uploads.length, 0);
});

test("returns 401 for an unknown user", async () => {
  const fixture = createFixture();

  await expectServiceError(
    fixture.service.submit({ userId: "missing-user", body: BASE_BODY }),
    401,
    "CURRENT_USER_NOT_FOUND",
  );

  assert.equal(fixture.uploads.length, 0);
});

test("returns 403 for a BLOCKED user", async () => {
  const fixture = createFixture({
    currentUser: createUser({
      id: "blocked-1",
      status: "BLOCKED",
    }),
  });

  await expectServiceError(
    fixture.service.submit({ userId: "blocked-1", body: BASE_BODY }),
    403,
    "CURRENT_USER_BLOCKED",
  );

  assert.equal(fixture.uploads.length, 0);
});

test("returns 403 for an authenticated user without an allowed role", async () => {
  const fixture = createFixture({
    currentUser: createUser({
      id: "roleless-1",
      roles: [],
    }),
  });

  await expectServiceError(
    fixture.service.submit({ userId: "roleless-1", body: BASE_BODY }),
    403,
    "CURRENT_USER_ROLE_FORBIDDEN",
  );

  assert.equal(fixture.uploads.length, 0);
});

for (const role of ["CANDIDATE", "RECRUITER", "ADMIN"]) {
  test(`allows an active ${role} to submit a support ticket`, async () => {
    const fixture = createFixture({
      currentUser: createUser({ id: `${role.toLowerCase()}-1`, roles: [role] }),
    });

    const result = await fixture.service.submit({
      userId: fixture.currentUser.id,
      body: BASE_BODY,
    });

    assert.deepEqual(result, {
      ticketId: FIXED_UUID,
      createdAt: FIXED_DATE.toISOString(),
      status: "submitted",
    });
    assert.equal(fixture.uploads.length, 1);
  });
}

for (const scenario of [
  {
    name: "missing summary",
    body: { ...BASE_BODY, summary: undefined },
    code: "INVALID_SUMMARY",
  },
  {
    name: "whitespace summary",
    body: { ...BASE_BODY, summary: "   " },
    code: "INVALID_SUMMARY",
  },
  {
    name: "too long summary",
    body: { ...BASE_BODY, summary: "x".repeat(MAX_SUMMARY_LENGTH + 1) },
    code: "INVALID_SUMMARY",
  },
  {
    name: "invalid priority",
    body: { ...BASE_BODY, priority: "Urgent" },
    code: "INVALID_PRIORITY",
  },
  {
    name: "invalid positionId",
    body: { ...BASE_BODY, positionId: "123" },
    code: "INVALID_POSITION_ID",
  },
  {
    name: "javascript link",
    body: { ...BASE_BODY, link: "javascript:alert(1)" },
    code: "INVALID_LINK",
  },
  {
    name: "external origin",
    body: { ...BASE_BODY, link: "https://malicious.example/cvs/7" },
    code: "INVALID_LINK",
  },
  {
    name: "server-controlled fields",
    body: {
      ...BASE_BODY,
      reportedBy: { name: "Forged User" },
      adminEmails: ["attacker@example.com"],
    },
    code: "UNSUPPORTED_REQUEST_FIELDS",
  },
]) {
  test(`rejects ${scenario.name}`, async () => {
    const fixture = createFixture();

    await expectServiceError(
      fixture.service.submit({
        userId: fixture.currentUser.id,
        body: scenario.body,
      }),
      400,
      scenario.code,
    );

    assert.equal(fixture.uploads.length, 0);
  });
}

test("returns 404 when the supplied Position does not exist", async () => {
  const fixture = createFixture({ position: null });

  await expectServiceError(
    fixture.service.submit({
      userId: fixture.currentUser.id,
      body: BASE_BODY,
    }),
    404,
    "POSITION_NOT_FOUND",
  );

  assert.equal(fixture.uploads.length, 0);
});

test("returns a safe configuration error when no valid active ADMIN email exists", async () => {
  const fixture = createFixture({
    admins: [
      createUser({
        id: "blocked-admin",
        roles: ["ADMIN"],
        status: "BLOCKED",
      }),
      createUser({
        id: "invalid-admin",
        roles: ["ADMIN"],
        email: "not-an-email",
      }),
    ],
  });

  await expectServiceError(
    fixture.service.submit({
      userId: fixture.currentUser.id,
      body: BASE_BODY,
    }),
    503,
    "SUPPORT_RECIPIENTS_MISSING",
  );
});

test("builds the exact database-derived Power Automate payload", async () => {
  const currentUser = createUser({
    id: "multi-role-user",
    name: "Database Candidate",
    email: "  reporter@example.com  ",
    roles: ["RECRUITER", "CANDIDATE", "RECRUITER"],
  });

  const fixture = createFixture({
    currentUser,
    admins: [
      createUser({
        id: "admin-z",
        roles: ["ADMIN"],
        email: "z-admin@example.com",
      }),
      createUser({
        id: "admin-a",
        roles: ["ADMIN"],
        email: " a-admin@example.com ",
      }),
      createUser({
        id: "admin-duplicate",
        roles: ["ADMIN"],
        email: "A-ADMIN@example.com",
      }),
      createUser({
        id: "blocked-admin",
        roles: ["ADMIN"],
        status: "BLOCKED",
        email: "blocked@example.com",
      }),
    ],
  });

  await fixture.service.submit({
    userId: currentUser.id,
    body: BASE_BODY,
  });

  assert.equal(fixture.uploads.length, 1);

  const upload = fixture.uploads[0];

  assert.equal(upload.filename, `support-ticket-${"20260803T120501123Z"}-${FIXED_UUID}.json`);
  assert.equal(upload.driveId, "drive-1");
  assert.equal(upload.folderPath, "support-tickets");
  assert.equal(upload.accessToken, "internal-access-token");
  assert.deepEqual(upload.content, {
    schemaVersion: 1,
    ticketId: FIXED_UUID,
    createdAt: FIXED_DATE.toISOString(),
    summary: "Cannot publish my CV",
    priority: "High",
    reportedBy: {
      name: "Database Candidate",
      email: "reporter@example.com",
      roles: ["CANDIDATE", "RECRUITER"],
    },
    position: {
      id: 123,
      title: "Frontend Developer",
    },
    link: `${ALLOWED_ORIGIN}/cvs/7?from=my-cvs`,
    adminEmails: ["a-admin@example.com", "z-admin@example.com"],
  });

  const serializedPayload = JSON.stringify(upload.content);
  assert.doesNotMatch(serializedPayload, /PRIVATE_PASSWORD_HASH/);
  assert.doesNotMatch(serializedPayload, /PRIVATE_ROLE_SECRET/);
  assert.doesNotMatch(serializedPayload, /blocked@example\.com/);

  const adminQuery = fixture.prisma.calls.find(
    (call) => call.model === "user" && call.operation === "findMany",
  );

  assert.deepEqual(adminQuery.args.where, {
    status: "ACTIVE",
    roles: {
      some: {
        role: {
          name: "ADMIN",
        },
      },
    },
  });
  assert.deepEqual(adminQuery.args.select, { email: true });
});

test("uses null email and Position when optional values are absent", async () => {
  const currentUser = createUser({
    id: "candidate-no-email",
    email: null,
  });
  const fixture = createFixture({ currentUser });
  const body = { ...BASE_BODY };
  delete body.positionId;

  await fixture.service.submit({
    userId: currentUser.id,
    body,
  });

  assert.equal(fixture.uploads[0].content.reportedBy.email, null);
  assert.equal(fixture.uploads[0].content.position, null);
  assert.equal(
    fixture.prisma.calls.filter((call) => call.model === "position").length,
    0,
  );
});

test("returns 503 when the future token provider is unavailable", async () => {
  const fixture = createFixture({
    getAccessToken: async () => {
      throw new Error("PRIVATE_REFRESH_TOKEN_ERROR");
    },
  });

  await expectServiceError(
    fixture.service.submit({
      userId: fixture.currentUser.id,
      body: BASE_BODY,
    }),
    503,
    "MICROSOFT_AUTHENTICATION_FAILED",
  );

  assert.equal(fixture.uploads.length, 0);
});

test("returns 503 when Microsoft upload configuration is incomplete", async () => {
  const fixture = createFixture({ driveId: "" });

  await expectServiceError(
    fixture.service.submit({
      userId: fixture.currentUser.id,
      body: BASE_BODY,
    }),
    503,
    "MICROSOFT_INTEGRATION_UNAVAILABLE",
  );

  assert.equal(fixture.uploads.length, 0);
});

for (const scenario of [
  {
    kind: "AUTHENTICATION",
    expectedStatus: 503,
    expectedCode: "MICROSOFT_INTEGRATION_UNAVAILABLE",
  },
  {
    kind: "THROTTLED",
    expectedStatus: 503,
    expectedCode: "MICROSOFT_INTEGRATION_THROTTLED",
  },
  {
    kind: "TIMEOUT",
    expectedStatus: 502,
    expectedCode: "ONEDRIVE_UPLOAD_FAILED",
  },
  {
    kind: "UPSTREAM",
    expectedStatus: 502,
    expectedCode: "ONEDRIVE_UPLOAD_FAILED",
  },
]) {
  test(`maps ${scenario.kind} Graph failure to a safe domain error`, async () => {
    const fixture = createFixture({
      uploadJson: async () => {
        throw new OneDriveGraphError("PRIVATE_GRAPH_BODY", {
          kind: scenario.kind,
        });
      },
    });

    await assert.rejects(
      fixture.service.submit({
        userId: fixture.currentUser.id,
        body: BASE_BODY,
      }),
      (error) => {
        assert.ok(error instanceof SupportTicketError);
        assert.equal(error.statusCode, scenario.expectedStatus);
        assert.equal(error.code, scenario.expectedCode);
        assert.doesNotMatch(error.message, /PRIVATE_GRAPH_BODY/);
        return true;
      },
    );
  });
}

test("calls the token provider and Graph uploader exactly once", async () => {
  let tokenCalls = 0;
  let uploadCalls = 0;
  const signal = new AbortController().signal;
  const fixture = createFixture({
    getAccessToken: async ({ signal: receivedSignal }) => {
      tokenCalls += 1;
      assert.equal(receivedSignal, signal);
      return "internal-access-token";
    },
    uploadJson: async ({ signal: receivedSignal }) => {
      uploadCalls += 1;
      assert.equal(receivedSignal, signal);
      return { uploaded: true };
    },
  });

  await fixture.service.submit({
    userId: fixture.currentUser.id,
    body: BASE_BODY,
    signal,
  });

  assert.equal(tokenCalls, 1);
  assert.equal(uploadCalls, 1);
});

test("buildSupportTicketFilename is safe, unique, and contains no PII", () => {
  const first = buildSupportTicketFilename(FIXED_DATE, FIXED_UUID);
  const second = buildSupportTicketFilename(
    FIXED_DATE,
    "7f39289a-1bc1-46d3-aee8-bd3c9ee765b0",
  );

  assert.match(
    first,
    /^support-ticket-\d{8}T\d{9}Z-[0-9a-f-]{36}\.json$/,
  );
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /Candidate|candidate@example\.com|Frontend/);
  assert.doesNotMatch(first, /\.\.|\/|\\/);
});
