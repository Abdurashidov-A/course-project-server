const assert = require("node:assert/strict");
const test = require("node:test");
const {
  SalesforceConfigError,
  createSalesforceClient,
  escapeSoqlString,
  splitContactName,
} = require("../src/integrations/salesforceClient");

const TEST_ENV = {
  SALESFORCE_LOGIN_URL:
    "https://orgfarm-904fbca921-dev-ed.develop.my.salesforce.com",
  SALESFORCE_CLIENT_ID: "test-client-id",
  SALESFORCE_CLIENT_SECRET: "test-client-secret",
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

test("splitContactName creates a Salesforce-compatible last name", () => {
  assert.deepEqual(splitContactName("Abduqahhor Abdurashidov"), {
    firstName: "Abduqahhor",
    lastName: "Abdurashidov",
  });
  assert.deepEqual(splitContactName("Madonna"), {
    firstName: null,
    lastName: "Madonna",
  });
  assert.deepEqual(splitContactName(""), {
    firstName: null,
    lastName: "Candidate",
  });
});

test("escapeSoqlString escapes quotes and backslashes", () => {
  assert.equal(escapeSoqlString("O'Neil\\QA"), "O\\'Neil\\\\QA");
});

test("rejects an incomplete Salesforce configuration before a request", async () => {
  const client = createSalesforceClient({
    env: {
      SALESFORCE_LOGIN_URL: TEST_ENV.SALESFORCE_LOGIN_URL,
    },
    fetchImpl: async () => {
      throw new Error("fetch must not be called");
    },
  });

  await assert.rejects(
    client.getConnectionStatus(),
    SalesforceConfigError,
  );
});

test("authenticates with client credentials and discovers the latest API version", async () => {
  const calls = [];
  const client = createSalesforceClient({
    env: TEST_ENV,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });

      if (String(url).endsWith("/services/oauth2/token")) {
        return jsonResponse({
          access_token: "access-token",
          instance_url: "https://example.my.salesforce.com",
        });
      }

      return jsonResponse([
        { version: "64.0", url: "/services/data/v64.0" },
        { version: "65.0", url: "/services/data/v65.0" },
      ]);
    },
  });

  const result = await client.getConnectionStatus();

  assert.deepEqual(result, {
    connected: true,
    instanceUrl: "https://example.my.salesforce.com",
    apiVersion: "v65.0",
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body.get("grant_type"), "client_credentials");
  assert.equal(calls[0].init.body.get("client_id"), "test-client-id");
  assert.equal(calls[0].init.body.get("client_secret"), "test-client-secret");
  assert.equal(calls[1].init.headers.Authorization, "Bearer access-token");
});

test("exports a profile without creating duplicate Salesforce records", async () => {
  const calls = [];
  const client = createSalesforceClient({
    env: TEST_ENV,
    fetchImpl: async (url, init = {}) => {
      const stringUrl = String(url);
      calls.push({ url: stringUrl, init });

      if (stringUrl.endsWith("/services/oauth2/token")) {
        return jsonResponse({
          access_token: "access-token",
          instance_url: "https://example.my.salesforce.com",
        });
      }

      if (stringUrl.endsWith("/services/data/")) {
        return jsonResponse([
          { version: "65.0", url: "/services/data/v65.0" },
        ]);
      }

      if (
        stringUrl.includes("/query?") &&
        decodeURIComponent(stringUrl).includes("FROM Account")
      ) {
        return jsonResponse({
          records: [{ Id: "001-account", Name: "CVMS - Frontend Developer" }],
        });
      }

      if (
        stringUrl.includes("/query?") &&
        decodeURIComponent(stringUrl).includes("FROM Contact")
      ) {
        return jsonResponse({
          records: [
            {
              Id: "003-contact",
              Email: "candidate@test.com",
              AccountId: "001-account",
            },
          ],
        });
      }

      throw new Error(`Unexpected request: ${stringUrl}`);
    },
  });

  const result = await client.exportProfile({
    userName: "Candidate User",
    email: "candidate@test.com",
    accountName: "Candidate Company",
    phone: "+998 90 123 45 67",
  });

  assert.deepEqual(result, {
    account: {
      id: "001-account",
      name: "Candidate Company",
      created: false,
    },
    contact: {
      id: "003-contact",
      created: false,
    },
  });
  assert.equal(calls.length, 4);
  assert.equal(
    calls.filter(({ init }) => init.method === "POST").length,
    1,
  );
});

test("creates Account and linked Contact from profile and form data", async () => {
  const createdPayloads = [];
  const client = createSalesforceClient({
    env: TEST_ENV,
    fetchImpl: async (url, init = {}) => {
      const stringUrl = String(url);

      if (stringUrl.endsWith("/services/oauth2/token")) {
        return jsonResponse({
          access_token: "access-token",
          instance_url: "https://example.my.salesforce.com",
        });
      }

      if (stringUrl.endsWith("/services/data/")) {
        return jsonResponse([
          { version: "65.0", url: "/services/data/v65.0" },
        ]);
      }

      if (stringUrl.includes("/query?")) {
        return jsonResponse({ records: [] });
      }

      if (stringUrl.endsWith("/sobjects/Account")) {
        createdPayloads.push(JSON.parse(init.body));
        return jsonResponse({ id: "001-created", success: true }, 201);
      }

      if (stringUrl.endsWith("/sobjects/Contact")) {
        createdPayloads.push(JSON.parse(init.body));
        return jsonResponse({ id: "003-created", success: true }, 201);
      }

      throw new Error(`Unexpected request: ${stringUrl}`);
    },
  });

  const result = await client.exportProfile({
    userName: "Candidate User",
    email: "candidate@test.com",
    accountName: "Candidate Company",
    phone: "+998 90 123 45 67",
  });

  assert.deepEqual(result, {
    account: {
      id: "001-created",
      name: "Candidate Company",
      created: true,
    },
    contact: {
      id: "003-created",
      created: true,
    },
  });
  assert.deepEqual(createdPayloads, [
    {
      Name: "Candidate Company",
    },
    {
      FirstName: "Candidate",
      LastName: "User",
      Email: "candidate@test.com",
      AccountId: "001-created",
      Phone: "+998 90 123 45 67",
    },
  ]);
});