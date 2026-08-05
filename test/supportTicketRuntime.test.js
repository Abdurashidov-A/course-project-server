const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const test = require("node:test");
const express = require("express");
const {
  NOT_CONFIGURED_CODE,
  createSupportTicketRuntimeRouter,
  isSupportTicketsEnabled,
} = require("../src/services/supportTicketRuntime");

const ALLOWED_ORIGIN = "https://client.example";
const COMPLETE_ENV = {
  SUPPORT_TICKETS_ENABLED: "true",
  CLIENT_URL: ALLOWED_ORIGIN,
  MICROSOFT_TENANT_ID: "test-tenant-id",
  MICROSOFT_CLIENT_ID: "test-client-id",
  MICROSOFT_CLIENT_SECRET: "test-client-secret",
  MICROSOFT_REFRESH_TOKEN: "test-refresh-token",
  MICROSOFT_GRAPH_SCOPES: "https://graph.microsoft.com/Files.ReadWrite",
  MICROSOFT_ONEDRIVE_DRIVE_ID: "drive-1",
  ONEDRIVE_SUPPORT_FOLDER: "SupportTickets",
};

function createPrismaClient(calls = []) {
  return {
    user: {
      async findUnique() {
        calls.push("user.findUnique");
        return {
          id: "candidate-1",
          name: "Candidate User",
          email: "candidate@example.com",
          status: "ACTIVE",
          roles: [{ role: { name: "CANDIDATE" } }],
        };
      },
      async findMany() {
        calls.push("user.findMany");
        return [{ email: "admin@example.com" }];
      },
    },
    position: {
      async findUnique() {
        assert.fail("Position lookup is not expected without positionId");
      },
    },
  };
}

function createTestApp(options) {
  const app = express();

  app.use(express.json());
  app.use("/api/support-tickets", createSupportTicketRuntimeRouter(options));

  return app;
}

async function withServer(app, callback) {
  const server = app.listen(0);

  await new Promise((resolve) => server.once("listening", resolve));

  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function postTicket(app) {
  let result;

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/support-tickets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-dev-user-id": "candidate-1",
      },
      body: JSON.stringify({
        summary: "Cannot publish my CV",
        priority: "Average",
        link: `${ALLOWED_ORIGIN}/cvs/7`,
      }),
    });

    result = {
      status: response.status,
      body: await response.json(),
    };
  });

  return result;
}

test("feature flag is disabled by default and requires an explicit true value", () => {
  assert.equal(isSupportTicketsEnabled(undefined), false);
  assert.equal(isSupportTicketsEnabled("false"), false);
  assert.equal(isSupportTicketsEnabled("TRUE"), false);
  assert.equal(isSupportTicketsEnabled("true"), true);
  assert.equal(isSupportTicketsEnabled(true), true);
});

test("disabled endpoint returns a safe 503 without touching dependencies", async () => {
  let prismaReads = 0;
  let providerFactoryCalls = 0;
  let accessTokenCalls = 0;
  let uploadCalls = 0;
  const prismaClient = new Proxy(
    {},
    {
      get() {
        prismaReads += 1;
        return undefined;
      },
    },
  );
  const app = createTestApp({
    enabled: false,
    prismaClient,
    driveId: "drive-1",
    allowedOrigins: [ALLOWED_ORIGIN],
    tokenProviderFactory: () => {
      providerFactoryCalls += 1;
      return async () => "PRIVATE_ACCESS_TOKEN";
    },
    getAccessToken: async () => {
      accessTokenCalls += 1;
      return "PRIVATE_ACCESS_TOKEN";
    },
    uploadJson: async () => {
      uploadCalls += 1;
    },
  });

  const response = await postTicket(app);

  assert.equal(response.status, 503);
  assert.deepEqual(response.body, {
    error: {
      code: NOT_CONFIGURED_CODE,
      message: "Support ticket delivery is temporarily unavailable",
    },
  });
  assert.equal(prismaReads, 0);
  assert.equal(providerFactoryCalls, 0);
  assert.equal(accessTokenCalls, 0);
  assert.equal(uploadCalls, 0);
  assert.doesNotMatch(JSON.stringify(response.body), /PRIVATE_ACCESS_TOKEN/);
});

test("enabled endpoint still fails closed when a real token provider is absent", async () => {
  let prismaReads = 0;
  let providerFactoryCalls = 0;
  const app = createTestApp({
    env: {
      ...COMPLETE_ENV,
      MICROSOFT_REFRESH_TOKEN: "   ",
    },
    prismaClient: new Proxy(
      {},
      {
        get() {
          prismaReads += 1;
          return undefined;
        },
      },
    ),
    tokenProviderFactory: () => {
      providerFactoryCalls += 1;
      return async () => "PRIVATE_ACCESS_TOKEN";
    },
    uploadJson: async () => assert.fail("Graph uploader must not run"),
  });

  const response = await postTicket(app);

  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, NOT_CONFIGURED_CODE);
  assert.equal(prismaReads, 0);
  assert.equal(providerFactoryCalls, 0);
});

test("enabled endpoint uses only injected token and upload dependencies", async () => {
  const calls = [];
  const prismaClient = createPrismaClient(calls);
  const app = createTestApp({
    enabled: true,
    prismaClient,
    driveId: "drive-1",
    folderPath: "support-tickets",
    allowedOrigins: [ALLOWED_ORIGIN],
    now: () => new Date("2026-08-03T12:05:01.123Z"),
    randomUUID: () => "550e8400-e29b-41d4-a716-446655440000",
    getAccessToken: async () => {
      calls.push("getAccessToken");
      return "PRIVATE_ACCESS_TOKEN";
    },
    uploadJson: async (args) => {
      calls.push("uploadJson");
      assert.equal(args.accessToken, "PRIVATE_ACCESS_TOKEN");
      assert.equal(args.driveId, "drive-1");
    },
  });

  const response = await postTicket(app);

  assert.equal(response.status, 201);
  assert.deepEqual(response.body, {
    ticketId: "550e8400-e29b-41d4-a716-446655440000",
    createdAt: "2026-08-03T12:05:01.123Z",
    status: "submitted",
  });
  assert.deepEqual(calls, [
    "user.findUnique",
    "user.findMany",
    "getAccessToken",
    "uploadJson",
  ]);
  assert.doesNotMatch(JSON.stringify(response.body), /PRIVATE_ACCESS_TOKEN/);
});

test("complete configuration creates the provider but fetches a token lazily", async () => {
  const calls = [];
  const tokenRequests = [];
  let uploadCalls = 0;
  const app = createTestApp({
    env: COMPLETE_ENV,
    prismaClient: createPrismaClient(calls),
    tokenFetchImpl: async (url, init) => {
      tokenRequests.push({ url, init });

      return {
        ok: true,
        status: 200,
        async json() {
          return {
            access_token: "PRIVATE_RUNTIME_ACCESS_TOKEN",
            expires_in: 3_600,
          };
        },
      };
    },
    uploadJson: async (args) => {
      uploadCalls += 1;
      assert.equal(args.accessToken, "PRIVATE_RUNTIME_ACCESS_TOKEN");
      assert.equal(args.driveId, "drive-1");
      assert.equal(args.folderPath, "SupportTickets");
    },
    now: () => new Date("2026-08-03T12:05:01.123Z"),
    randomUUID: () => "550e8400-e29b-41d4-a716-446655440000",
  });

  assert.equal(tokenRequests.length, 0);
  assert.equal(uploadCalls, 0);
  assert.equal(calls.length, 0);

  const response = await postTicket(app);

  assert.equal(response.status, 201);
  assert.equal(tokenRequests.length, 1);
  assert.equal(
    tokenRequests[0].url,
    "https://login.microsoftonline.com/test-tenant-id/oauth2/v2.0/token",
  );
  assert.equal(
    tokenRequests[0].init.body.get("client_id"),
    COMPLETE_ENV.MICROSOFT_CLIENT_ID,
  );
  assert.equal(
    tokenRequests[0].init.body.get("client_secret"),
    COMPLETE_ENV.MICROSOFT_CLIENT_SECRET,
  );
  assert.equal(
    tokenRequests[0].init.body.get("refresh_token"),
    COMPLETE_ENV.MICROSOFT_REFRESH_TOKEN,
  );
  assert.equal(
    tokenRequests[0].init.body.get("scope"),
    COMPLETE_ENV.MICROSOFT_GRAPH_SCOPES,
  );
  assert.equal(uploadCalls, 1);
  assert.deepEqual(calls, ["user.findUnique", "user.findMany"]);
  assert.doesNotMatch(
    JSON.stringify(response.body),
    /PRIVATE_RUNTIME_ACCESS_TOKEN|test-client-secret|test-refresh-token/,
  );
});

test("token refresh failures stay behind the existing safe 503 contract", async () => {
  const privateMicrosoftDetails = "PRIVATE_MICROSOFT_REFRESH_DETAILS";
  let uploadCalls = 0;
  const app = createTestApp({
    env: COMPLETE_ENV,
    prismaClient: createPrismaClient(),
    tokenProviderFactory: () => async () => {
      throw new Error(privateMicrosoftDetails);
    },
    uploadJson: async () => {
      uploadCalls += 1;
    },
  });

  const response = await postTicket(app);

  assert.equal(response.status, 503);
  assert.deepEqual(response.body, {
    message: "Support ticket integration is not configured",
  });
  assert.equal(uploadCalls, 0);
  assert.doesNotMatch(
    JSON.stringify(response.body),
    new RegExp(privateMicrosoftDetails),
  );
});

test("application registers the runtime router at the public endpoint path", async () => {
  const appSource = await readFile(
    new URL("../src/app.js", `file://${__filename}`),
    "utf8",
  );

  assert.match(appSource, /createSupportTicketRuntimeRouter/);
  assert.match(appSource, /"\/api\/support-tickets"/);
  assert.doesNotMatch(appSource, /accessToken\s*:/);
});
