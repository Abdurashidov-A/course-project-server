const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const {
  createSupportTicketRouter,
} = require("../src/routes/supportTicketRoutes");
const {
  SupportTicketError,
} = require("../src/services/supportTicketService");

function createTestApp(supportTicketService) {
  const app = express();

  app.use(express.json());
  app.use(
    "/api/support-tickets",
    createSupportTicketRouter({ supportTicketService }),
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

test("route factory requires an injected support ticket service", () => {
  assert.throws(
    () => createSupportTicketRouter(),
    /supportTicketService with submit\(\) is required/,
  );
});

test("POST returns only the safe 201 response contract", async () => {
  const calls = [];
  const app = createTestApp({
    async submit(args) {
      calls.push(args);
      return {
        ticketId: "550e8400-e29b-41d4-a716-446655440000",
        createdAt: "2026-08-03T12:05:01.123Z",
        status: "submitted",
      };
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/support-tickets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-dev-user-id": "candidate-1",
      },
      body: JSON.stringify({
        summary: "Cannot publish my CV",
        priority: "High",
        link: "https://client.example/cvs/7",
      }),
    });

    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      ticketId: "550e8400-e29b-41d4-a716-446655440000",
      createdAt: "2026-08-03T12:05:01.123Z",
      status: "submitted",
    });
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].userId, "candidate-1");
  assert.ok(calls[0].signal instanceof AbortSignal);
});

test("POST maps expected service errors without changing their status", async () => {
  const app = createTestApp({
    async submit() {
      throw new SupportTicketError("Current user is blocked", {
        statusCode: 403,
        code: "CURRENT_USER_BLOCKED",
      });
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/support-tickets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-dev-user-id": "blocked-1",
      },
      body: JSON.stringify({}),
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      message: "Current user is blocked",
    });
  });
});

test("POST preserves the safe public error contract when a public code is provided", async () => {
  const app = createTestApp({
    async submit() {
      throw new SupportTicketError(
        "Support ticket delivery is temporarily unavailable",
        {
          statusCode: 503,
          code: "SUPPORT_TICKETS_NOT_CONFIGURED",
          publicCode: "SUPPORT_TICKETS_NOT_CONFIGURED",
        },
      );
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/support-tickets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: {
        code: "SUPPORT_TICKETS_NOT_CONFIGURED",
        message: "Support ticket delivery is temporarily unavailable",
      },
    });
  });
});

test("POST maps an unexpected error to a safe 500 response", async () => {
  const privateMarker = "PRIVATE_UNEXPECTED_ERROR_MARKER";
  const originalConsoleError = console.error;
  const loggedValues = [];
  console.error = (...values) => loggedValues.push(values);

  try {
    const app = createTestApp({
      async submit() {
        throw new Error(privateMarker);
      },
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/support-tickets`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-dev-user-id": "candidate-1",
        },
        body: JSON.stringify({}),
      });

      assert.equal(response.status, 500);

      const responseBody = await response.json();
      assert.deepEqual(responseBody, {
        message: "Failed to submit support ticket",
      });
      assert.doesNotMatch(JSON.stringify(responseBody), new RegExp(privateMarker));
    });
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(loggedValues.length, 1);
  assert.doesNotMatch(JSON.stringify(loggedValues), new RegExp(privateMarker));
});
