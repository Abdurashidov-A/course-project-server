const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const {
  MAX_EXPIRES_IN_SECONDS,
  MicrosoftGraphTokenError,
  buildMicrosoftTokenEndpoint,
  createMicrosoftGraphTokenProvider,
} = require("../src/integrations/microsoftGraphTokenProvider");

const PRIVATE_MARKERS = {
  tenantId: "tenant/id with spaces",
  clientId: "client-id+private&marker",
  clientSecret: "client-secret+private&marker",
  refreshToken: "refresh-token+private&marker",
  accessToken: "access-token-private-marker",
  rotatedRefreshToken: "rotated-refresh-token-private-marker",
};

function createJsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

function createProvider(options = {}) {
  return createMicrosoftGraphTokenProvider({
    tenantId: PRIVATE_MARKERS.tenantId,
    clientId: PRIVATE_MARKERS.clientId,
    clientSecret: PRIVATE_MARKERS.clientSecret,
    refreshToken: PRIVATE_MARKERS.refreshToken,
    safetyBufferSeconds: 60,
    ...options,
  });
}

function assertSafeError(error, expectedCode) {
  assert.ok(error instanceof MicrosoftGraphTokenError);
  assert.equal(error.code, expectedCode);

  for (const marker of Object.values(PRIVATE_MARKERS)) {
    assert.doesNotMatch(error.message, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  return true;
}

test("builds the encoded Microsoft v2 token endpoint", () => {
  assert.equal(
    buildMicrosoftTokenEndpoint(PRIVATE_MARKERS.tenantId),
    "https://login.microsoftonline.com/tenant%2Fid%20with%20spaces/oauth2/v2.0/token",
  );
});

test("sends one correctly encoded refresh-token request and returns only the access token", async () => {
  const calls = [];
  const getAccessToken = createProvider({
    scopes: ["https://graph.microsoft.com/Files.ReadWrite", "offline_access"],
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return createJsonResponse({
        access_token: PRIVATE_MARKERS.accessToken,
        expires_in: 3_600,
        token_type: "Bearer",
        private_response_marker: "PRIVATE_OAUTH_RESPONSE_BODY",
      });
    },
  });

  const result = await getAccessToken();

  assert.equal(result, PRIVATE_MARKERS.accessToken);
  assert.equal(typeof result, "string");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://login.microsoftonline.com/tenant%2Fid%20with%20spaces/oauth2/v2.0/token",
  );
  assert.equal(calls[0].init.method, "POST");
  assert.equal(
    calls[0].init.headers["Content-Type"],
    "application/x-www-form-urlencoded",
  );
  assert.ok(calls[0].init.body instanceof URLSearchParams);
  assert.equal(calls[0].init.body.get("client_id"), PRIVATE_MARKERS.clientId);
  assert.equal(
    calls[0].init.body.get("client_secret"),
    PRIVATE_MARKERS.clientSecret,
  );
  assert.equal(calls[0].init.body.get("grant_type"), "refresh_token");
  assert.equal(
    calls[0].init.body.get("refresh_token"),
    PRIVATE_MARKERS.refreshToken,
  );
  assert.equal(
    calls[0].init.body.get("scope"),
    "https://graph.microsoft.com/Files.ReadWrite offline_access",
  );
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.doesNotMatch(result, /PRIVATE_OAUTH_RESPONSE_BODY/);
});

test("omits scope when no refresh scope is configured", async () => {
  let requestBody;
  const getAccessToken = createProvider({
    scopes: "   ",
    fetchImpl: async (_url, init) => {
      requestBody = init.body;
      return createJsonResponse({
        access_token: PRIVATE_MARKERS.accessToken,
        expires_in: 3_600,
      });
    },
  });

  await getAccessToken();

  assert.equal(requestBody.has("scope"), false);
});

test("rejects missing or whitespace-only required configuration without fetch", () => {
  let fetchCalls = 0;

  for (const field of ["tenantId", "clientId", "clientSecret", "refreshToken"]) {
    assert.throws(
      () =>
        createProvider({
          [field]: "   ",
          fetchImpl: async () => {
            fetchCalls += 1;
          },
        }),
      (error) =>
        error instanceof MicrosoftGraphTokenError &&
        error.kind === "CONFIGURATION" &&
        error.message === "Microsoft token provider is not configured",
    );
  }

  assert.equal(fetchCalls, 0);
});

test("caches the token while it remains outside the safety buffer", async () => {
  let currentTime = 0;
  let fetchCalls = 0;
  const getAccessToken = createProvider({
    now: () => currentTime,
    fetchImpl: async () => {
      fetchCalls += 1;
      return createJsonResponse({
        access_token: PRIVATE_MARKERS.accessToken,
        expires_in: 120,
      });
    },
  });

  assert.equal(await getAccessToken(), PRIVATE_MARKERS.accessToken);
  currentTime = 59_999;
  assert.equal(await getAccessToken(), PRIVATE_MARKERS.accessToken);
  assert.equal(fetchCalls, 1);
});

test("refreshes at the safety-buffer boundary before actual expiry", async () => {
  let currentTime = 0;
  let fetchCalls = 0;
  const getAccessToken = createProvider({
    now: () => currentTime,
    fetchImpl: async () => {
      fetchCalls += 1;
      return createJsonResponse({
        access_token: `access-token-${fetchCalls}`,
        expires_in: 120,
      });
    },
  });

  assert.equal(await getAccessToken(), "access-token-1");
  currentTime = 60_000;
  assert.equal(await getAccessToken(), "access-token-2");
  assert.equal(fetchCalls, 2);
});

test("refreshes after the cached token has expired", async () => {
  let currentTime = 0;
  let fetchCalls = 0;
  const getAccessToken = createProvider({
    now: () => currentTime,
    safetyBufferSeconds: 0,
    fetchImpl: async () => {
      fetchCalls += 1;
      return createJsonResponse({
        access_token: `expired-access-token-${fetchCalls}`,
        expires_in: 10,
      });
    },
  });

  await getAccessToken();
  currentTime = 10_001;
  assert.equal(await getAccessToken(), "expired-access-token-2");
  assert.equal(fetchCalls, 2);
});

test("coalesces parallel cache misses into one token request", async () => {
  let fetchCalls = 0;
  let releaseRequest;
  const requestGate = new Promise((resolve) => {
    releaseRequest = resolve;
  });
  const getAccessToken = createProvider({
    fetchImpl: async () => {
      fetchCalls += 1;
      await requestGate;
      return createJsonResponse({
        access_token: PRIVATE_MARKERS.accessToken,
        expires_in: 3_600,
      });
    },
  });
  const tokenRequests = [getAccessToken(), getAccessToken(), getAccessToken()];

  await Promise.resolve();
  assert.equal(fetchCalls, 1);
  releaseRequest();
  assert.deepEqual(await Promise.all(tokenRequests), [
    PRIVATE_MARKERS.accessToken,
    PRIVATE_MARKERS.accessToken,
    PRIVATE_MARKERS.accessToken,
  ]);
  assert.equal(fetchCalls, 1);
});

test("clears a failed single-flight request so a later call can retry", async () => {
  let fetchCalls = 0;
  const getAccessToken = createProvider({
    fetchImpl: async () => {
      fetchCalls += 1;

      if (fetchCalls === 1) {
        return createJsonResponse({}, 500);
      }

      return createJsonResponse({
        access_token: PRIVATE_MARKERS.accessToken,
        expires_in: 3_600,
      });
    },
  });

  await assert.rejects(
    getAccessToken(),
    (error) => assertSafeError(error, "MICROSOFT_TOKEN_REJECTED"),
  );
  assert.equal(await getAccessToken(), PRIVATE_MARKERS.accessToken);
  assert.equal(fetchCalls, 2);
});

test("enforces a timeout without exposing fetch failure details", async () => {
  const privateFetchMarker = "PRIVATE_TIMEOUT_FETCH_ERROR";
  const getAccessToken = createProvider({
    timeoutMs: 10,
    fetchImpl: async (_url, init) =>
      new Promise((resolve, reject) => {
        void resolve;
        init.signal.addEventListener(
          "abort",
          () => reject(new Error(privateFetchMarker)),
          { once: true },
        );
      }),
  });

  await assert.rejects(getAccessToken(), (error) => {
    assertSafeError(error, "MICROSOFT_TOKEN_TIMEOUT");
    assert.doesNotMatch(error.message, new RegExp(privateFetchMarker));
    return true;
  });
});

test("enforces the same timeout while reading the token response body", async () => {
  const getAccessToken = createProvider({
    timeoutMs: 10,
    fetchImpl: async (_url, init) => ({
      ok: true,
      status: 200,
      async json() {
        return new Promise((resolve, reject) => {
          void resolve;
          init.signal.addEventListener(
            "abort",
            () => reject(new Error("PRIVATE_BODY_TIMEOUT_DETAILS")),
            { once: true },
          );
        });
      },
    }),
  });

  await assert.rejects(
    getAccessToken(),
    (error) => assertSafeError(error, "MICROSOFT_TOKEN_TIMEOUT"),
  );
});

test("keeps non-2xx Microsoft response details private", async () => {
  const privateDescription = "PRIVATE_MICROSOFT_ERROR_DESCRIPTION";
  const getAccessToken = createProvider({
    fetchImpl: async () =>
      createJsonResponse(
        {
          error: "invalid_grant",
          error_description: privateDescription,
          refresh_token: PRIVATE_MARKERS.refreshToken,
        },
        401,
      ),
  });

  await assert.rejects(getAccessToken(), (error) => {
    assertSafeError(error, "MICROSOFT_TOKEN_REJECTED");
    assert.equal(error.status, 401);
    assert.doesNotMatch(error.message, new RegExp(privateDescription));
    return true;
  });
});

test("maps invalid JSON to a safe response error", async () => {
  const privateJsonMarker = "PRIVATE_INVALID_JSON_DETAILS";
  const getAccessToken = createProvider({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        throw new Error(privateJsonMarker);
      },
    }),
  });

  await assert.rejects(getAccessToken(), (error) => {
    assertSafeError(error, "INVALID_MICROSOFT_TOKEN_RESPONSE");
    assert.doesNotMatch(error.message, new RegExp(privateJsonMarker));
    return true;
  });
});

for (const scenario of [
  { name: "missing access token", accessToken: undefined },
  { name: "empty access token", accessToken: "   " },
]) {
  test(`rejects a ${scenario.name}`, async () => {
    const getAccessToken = createProvider({
      fetchImpl: async () =>
        createJsonResponse({
          access_token: scenario.accessToken,
          expires_in: 3_600,
        }),
    });

    await assert.rejects(
      getAccessToken(),
      (error) => assertSafeError(error, "MISSING_MICROSOFT_ACCESS_TOKEN"),
    );
  });
}

for (const expiresIn of [0, -1, 1.5, "3600", MAX_EXPIRES_IN_SECONDS + 1]) {
  test(`rejects unsafe expires_in value ${JSON.stringify(expiresIn)}`, async () => {
    const getAccessToken = createProvider({
      fetchImpl: async () =>
        createJsonResponse({
          access_token: PRIVATE_MARKERS.accessToken,
          expires_in: expiresIn,
        }),
    });

    await assert.rejects(
      getAccessToken(),
      (error) => assertSafeError(error, "INVALID_MICROSOFT_TOKEN_EXPIRY"),
    );
  });
}

test("uses a rotated refresh token only for subsequent in-process refreshes", async () => {
  let currentTime = 0;
  const requestBodies = [];
  const getAccessToken = createProvider({
    now: () => currentTime,
    fetchImpl: async (_url, init) => {
      requestBodies.push(new URLSearchParams(init.body));

      if (requestBodies.length === 1) {
        return createJsonResponse({
          access_token: "first-access-token",
          expires_in: 120,
          refresh_token: PRIVATE_MARKERS.rotatedRefreshToken,
        });
      }

      return createJsonResponse({
        access_token: "second-access-token",
        expires_in: 120,
      });
    },
  });

  assert.equal(await getAccessToken(), "first-access-token");
  currentTime = 60_000;
  assert.equal(await getAccessToken(), "second-access-token");
  assert.equal(
    requestBodies[0].get("refresh_token"),
    PRIVATE_MARKERS.refreshToken,
  );
  assert.equal(
    requestBodies[1].get("refresh_token"),
    PRIVATE_MARKERS.rotatedRefreshToken,
  );
});

test("production provider source contains no logging or persistent secret storage", async () => {
  const source = await readFile(
    path.join(
      __dirname,
      "../src/integrations/microsoftGraphTokenProvider.js",
    ),
    "utf8",
  );

  assert.doesNotMatch(source, /console\.|localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(source, /prisma|writeFile|appendFile/);
});
