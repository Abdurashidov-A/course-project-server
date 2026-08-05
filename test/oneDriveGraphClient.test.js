const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const {
  OneDriveGraphError,
  buildUploadUrl,
  createOneDriveGraphClient,
} = require("../src/integrations/oneDriveGraphClient");

const ACCESS_TOKEN = "test-access-token-private-marker";

function createResponse(status) {
  return {
    ok: status >= 200 && status < 300,
    status,
  };
}

function waitForAbort(signal) {
  return new Promise((resolve, reject) => {
    const rejectAsAborted = () => {
      const error = new Error("request aborted");
      error.name = "AbortError";
      reject(error);
    };

    if (signal.aborted) {
      rejectAsAborted();
      return;
    }

    signal.addEventListener("abort", rejectAsAborted, { once: true });
  });
}

test("buildUploadUrl encodes drive, folder, and filename path segments", () => {
  assert.equal(
    buildUploadUrl({
      driveId: "drive id/with slash",
      folderPath: "support tickets/2026 #3",
      filename: "ticket name.json",
    }),
    "https://graph.microsoft.com/v1.0/drives/drive%20id%2Fwith%20slash/root:/support%20tickets/2026%20%233/ticket%20name.json:/content",
  );
});

test("buildUploadUrl rejects traversal and unsafe filenames", () => {
  assert.throws(
    () =>
      buildUploadUrl({
        driveId: "drive-1",
        folderPath: "support-tickets/../private",
        filename: "ticket.json",
      }),
    (error) =>
      error instanceof OneDriveGraphError &&
      error.code === "INVALID_UPLOAD_PATH",
  );

  assert.throws(
    () =>
      buildUploadUrl({
        driveId: "drive-1",
        folderPath: "support-tickets",
        filename: "../ticket.json",
      }),
    (error) =>
      error instanceof OneDriveGraphError &&
      error.code === "INVALID_UPLOAD_FILENAME",
  );
});

test("uploadJson sends one safe JSON PUT request", async () => {
  const calls = [];
  const client = createOneDriveGraphClient({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return createResponse(201);
    },
  });

  const content = {
    schemaVersion: 1,
    ticketId: "ticket-id",
  };

  const result = await client.uploadJson({
    accessToken: ACCESS_TOKEN,
    driveId: "drive-1",
    folderPath: "support-tickets",
    filename: "support-ticket.json",
    content,
  });

  assert.deepEqual(result, { uploaded: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(
    calls[0].init.headers["Content-Type"],
    "application/json; charset=utf-8",
  );
  assert.equal(
    calls[0].init.headers.Authorization,
    `Bearer ${ACCESS_TOKEN}`,
  );
  assert.equal(calls[0].init.body, JSON.stringify(content));
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("uploadJson rejects non-serializable content safely", async () => {
  const content = {};
  content.circular = content;

  const client = createOneDriveGraphClient({
    fetchImpl: async () => {
      throw new Error("fetch must not be called");
    },
  });

  await assert.rejects(
    client.uploadJson({
      accessToken: ACCESS_TOKEN,
      driveId: "drive-1",
      folderPath: "support-tickets",
      filename: "support-ticket.json",
      content,
    }),
    (error) =>
      error instanceof OneDriveGraphError &&
      error.code === "INVALID_JSON_CONTENT",
  );
});

test("uploadJson respects an external AbortSignal", async () => {
  const controller = new AbortController();
  const client = createOneDriveGraphClient({
    timeoutMs: 1_000,
    fetchImpl: async (_url, init) => waitForAbort(init.signal),
  });

  const upload = client.uploadJson({
    accessToken: ACCESS_TOKEN,
    driveId: "drive-1",
    folderPath: "support-tickets",
    filename: "support-ticket.json",
    content: {},
    signal: controller.signal,
  });

  controller.abort();

  await assert.rejects(
    upload,
    (error) =>
      error instanceof OneDriveGraphError &&
      error.code === "GRAPH_UPLOAD_ABORTED",
  );
});

test("uploadJson enforces its internal timeout", async () => {
  const client = createOneDriveGraphClient({
    timeoutMs: 10,
    fetchImpl: async (_url, init) => waitForAbort(init.signal),
  });

  await assert.rejects(
    client.uploadJson({
      accessToken: ACCESS_TOKEN,
      driveId: "drive-1",
      folderPath: "support-tickets",
      filename: "support-ticket.json",
      content: {},
    }),
    (error) =>
      error instanceof OneDriveGraphError &&
      error.code === "GRAPH_UPLOAD_TIMEOUT",
  );
});

test("uploadJson maps a network failure without exposing the token", async () => {
  const client = createOneDriveGraphClient({
    fetchImpl: async () => {
      throw new Error(`network failed ${ACCESS_TOKEN}`);
    },
  });

  await assert.rejects(
    client.uploadJson({
      accessToken: ACCESS_TOKEN,
      driveId: "drive-1",
      folderPath: "support-tickets",
      filename: "support-ticket.json",
      content: {},
    }),
    (error) => {
      assert.ok(error instanceof OneDriveGraphError);
      assert.equal(error.code, "GRAPH_NETWORK_ERROR");
      assert.doesNotMatch(error.message, new RegExp(ACCESS_TOKEN));
      return true;
    },
  );
});

for (const scenario of [
  { status: 400, kind: "REQUEST", code: "GRAPH_UPLOAD_REJECTED" },
  { status: 401, kind: "AUTHENTICATION", code: "GRAPH_AUTHENTICATION_FAILED" },
  { status: 403, kind: "AUTHENTICATION", code: "GRAPH_AUTHENTICATION_FAILED" },
  { status: 429, kind: "THROTTLED", code: "GRAPH_THROTTLED" },
  { status: 500, kind: "UPSTREAM", code: "GRAPH_UPLOAD_FAILED" },
]) {
  test(`uploadJson maps Graph ${scenario.status} to a safe typed error`, async () => {
    const client = createOneDriveGraphClient({
      fetchImpl: async () => createResponse(scenario.status),
    });

    await assert.rejects(
      client.uploadJson({
        accessToken: ACCESS_TOKEN,
        driveId: "drive-1",
        folderPath: "support-tickets",
        filename: "support-ticket.json",
        content: {
          privateMarker: "PRIVATE_MICROSOFT_BODY_MARKER",
        },
      }),
      (error) => {
        assert.ok(error instanceof OneDriveGraphError);
        assert.equal(error.status, scenario.status);
        assert.equal(error.kind, scenario.kind);
        assert.equal(error.code, scenario.code);
        assert.doesNotMatch(error.message, /PRIVATE_MICROSOFT_BODY_MARKER/);
        assert.doesNotMatch(error.message, new RegExp(ACCESS_TOKEN));
        return true;
      },
    );
  });
}

test("Graph client production source does not log request secrets", async () => {
  const source = await readFile(
    path.join(__dirname, "../src/integrations/oneDriveGraphClient.js"),
    "utf8",
  );

  assert.doesNotMatch(source, /console\./);
});
