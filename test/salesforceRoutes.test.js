const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const {
  createSalesforceRouter,
  normalizeProfileForm,
} = require("../src/routes/salesforceRoutes");

function createUser(id, role, status = "ACTIVE") {
  return {
    id,
    name: `${role} User`,
    email: `${role.toLowerCase()}@test.com`,
    status,
    roles: [{ role: { name: role } }],
  };
}

function createTestApp(users, exportProfile) {
  const prismaClient = {
    user: {
      async findUnique(args) {
        const user = users.get(args.where.id) || null;

        if (!user || !args.select) {
          return user;
        }

        return Object.fromEntries(
          Object.keys(args.select)
            .filter((key) => args.select[key])
            .map((key) => [key, user[key]]),
        );
      },
    },
  };

  const salesforceClient = {
    async getConnectionStatus() {
      return { connected: true };
    },
    exportProfile,
  };

  const app = express();

  app.use(express.json());

  app.use(
    "/api/integrations/salesforce",
    createSalesforceRouter({
      prismaClient,
      salesforceClient,
    }),
  );

  return app;
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

test("normalizes and validates the additional profile form", () => {
  assert.deepEqual(
    normalizeProfileForm({
      accountName: "  Candidate Company  ",
      phone: "  +998 90 123 45 67  ",
    }),
    {
      value: {
        accountName: "Candidate Company",
        phone: "+998 90 123 45 67",
      },
    },
  );

  assert.deepEqual(
    normalizeProfileForm({
      accountName: " ",
    }),
    {
      error: "Account name must contain between 2 and 255 characters",
    },
  );
});

test("allows a profile owner in any role to create Salesforce records", async () => {
  const candidate = createUser("candidate-1", "CANDIDATE");
  const users = new Map([[candidate.id, candidate]]);
  const received = [];

  const app = createTestApp(users, async (payload) => {
    received.push(payload);

    return {
      account: {
        id: "001",
        name: payload.accountName,
        created: true,
      },
      contact: {
        id: "003",
        created: true,
      },
    };
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/integrations/salesforce/profiles/${candidate.id}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-dev-user-id": candidate.id,
        },
        body: JSON.stringify({
          accountName: "Candidate Company",
          phone: "+998 90 123 45 67",
        }),
      },
    );

    assert.equal(response.status, 201);

    assert.deepEqual(received, [
      {
        userName: "CANDIDATE User",
        email: "candidate@test.com",
        accountName: "Candidate Company",
        phone: "+998 90 123 45 67",
      },
    ]);
  });
});

test("allows an admin to export another user's profile", async () => {
  const admin = createUser("admin-1", "ADMIN");
  const candidate = createUser("candidate-1", "CANDIDATE");

  const users = new Map([
    [admin.id, admin],
    [candidate.id, candidate],
  ]);

  let exportCount = 0;

  const app = createTestApp(users, async () => {
    exportCount += 1;

    return {
      account: {
        id: "001",
        name: "Candidate Company",
        created: false,
      },
      contact: {
        id: "003",
        created: false,
      },
    };
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/integrations/salesforce/profiles/${candidate.id}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-dev-user-id": admin.id,
        },
        body: JSON.stringify({
          accountName: "Candidate Company",
        }),
      },
    );

    assert.equal(response.status, 200);
    assert.equal(exportCount, 1);
  });
});

test("rejects a recruiter exporting another user's profile", async () => {
  const recruiter = createUser("recruiter-1", "RECRUITER");
  const candidate = createUser("candidate-1", "CANDIDATE");

  const users = new Map([
    [recruiter.id, recruiter],
    [candidate.id, candidate],
  ]);

  let exportCount = 0;

  const app = createTestApp(users, async () => {
    exportCount += 1;
    return {};
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/integrations/salesforce/profiles/${candidate.id}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-dev-user-id": recruiter.id,
        },
        body: JSON.stringify({
          accountName: "Candidate Company",
        }),
      },
    );

    assert.equal(response.status, 403);
    assert.equal(exportCount, 0);
  });
});