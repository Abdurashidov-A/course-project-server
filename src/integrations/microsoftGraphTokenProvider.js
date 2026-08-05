const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_SAFETY_BUFFER_SECONDS = 60;
const MAX_EXPIRES_IN_SECONDS = 86_400;
const MICROSOFT_IDENTITY_BASE_URL = "https://login.microsoftonline.com";

class MicrosoftGraphTokenError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "MicrosoftGraphTokenError";
    this.kind = options.kind || "AUTHENTICATION";
    this.code = options.code || "MICROSOFT_TOKEN_ERROR";
    this.status = options.status || null;
  }
}

function createTokenError(message, options) {
  return new MicrosoftGraphTokenError(message, options);
}

function requireConfigurationString(value, fieldName) {
  const normalized = typeof value === "string" ? value.trim() : "";

  if (!normalized) {
    throw createTokenError("Microsoft token provider is not configured", {
      kind: "CONFIGURATION",
      code: `MISSING_${fieldName}`,
    });
  }

  return normalized;
}

function normalizeScopes(scopes) {
  const values = Array.isArray(scopes) ? scopes : [scopes];

  return values
    .flatMap((value) =>
      typeof value === "string" ? value.trim().split(/\s+/) : [],
    )
    .filter(Boolean)
    .join(" ");
}

function buildMicrosoftTokenEndpoint(tenantId) {
  const normalizedTenantId = requireConfigurationString(tenantId, "TENANT_ID");

  return `${MICROSOFT_IDENTITY_BASE_URL}/${encodeURIComponent(normalizedTenantId)}/oauth2/v2.0/token`;
}

function createRequestSignal(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;

  const abortFromExternalSignal = () => {
    controller.abort(externalSignal?.reason);
  };

  if (externalSignal?.aborted) {
    abortFromExternalSignal();
  } else if (externalSignal) {
    externalSignal.addEventListener("abort", abortFromExternalSignal, {
      once: true,
    });
  }

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timeoutId);

      if (externalSignal) {
        externalSignal.removeEventListener("abort", abortFromExternalSignal);
      }
    },
  };
}

function createMicrosoftGraphTokenProvider(options = {}) {
  const tenantId = requireConfigurationString(options.tenantId, "TENANT_ID");
  const clientId = requireConfigurationString(options.clientId, "CLIENT_ID");
  const clientSecret = requireConfigurationString(
    options.clientSecret,
    "CLIENT_SECRET",
  );
  const initialRefreshToken = requireConfigurationString(
    options.refreshToken,
    "REFRESH_TOKEN",
  );
  const scopes = normalizeScopes(options.scopes);
  const fetchImpl = options.fetchImpl || global.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const safetyBufferSeconds =
    options.safetyBufferSeconds ?? DEFAULT_SAFETY_BUFFER_SECONDS;
  const now = options.now || Date.now;
  const tokenEndpoint = buildMicrosoftTokenEndpoint(tenantId);

  if (typeof fetchImpl !== "function") {
    throw new TypeError("A fetch implementation is required");
  }

  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive integer");
  }

  if (!Number.isInteger(safetyBufferSeconds) || safetyBufferSeconds < 0) {
    throw new TypeError("safetyBufferSeconds must be a non-negative integer");
  }

  if (typeof now !== "function") {
    throw new TypeError("now must be a function");
  }

  let currentRefreshToken = initialRefreshToken;
  let cachedAccessToken = null;
  let accessTokenExpiresAt = 0;
  let pendingRefresh = null;

  function getCurrentTime() {
    const value = now();
    const timestamp = value instanceof Date ? value.getTime() : Number(value);

    if (!Number.isFinite(timestamp)) {
      throw createTokenError("Microsoft token provider clock is invalid", {
        kind: "CONFIGURATION",
        code: "INVALID_TOKEN_CLOCK",
      });
    }

    return timestamp;
  }

  function hasUsableCachedToken() {
    return (
      typeof cachedAccessToken === "string" &&
      cachedAccessToken.length > 0 &&
      getCurrentTime() + safetyBufferSeconds * 1_000 < accessTokenExpiresAt
    );
  }

  async function refreshAccessToken({ signal } = {}) {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: currentRefreshToken,
    });

    if (scopes) {
      body.set("scope", scopes);
    }

    const requestSignal = createRequestSignal(signal, timeoutMs);
    let response;

    try {
      response = await fetchImpl(tokenEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
        signal: requestSignal.signal,
      });
    } catch {
      requestSignal.cleanup();

      if (requestSignal.timedOut()) {
        throw createTokenError("Microsoft token request timed out", {
          kind: "TIMEOUT",
          code: "MICROSOFT_TOKEN_TIMEOUT",
        });
      }

      if (signal?.aborted || requestSignal.signal.aborted) {
        throw createTokenError("Microsoft token request was aborted", {
          kind: "ABORTED",
          code: "MICROSOFT_TOKEN_ABORTED",
        });
      }

      throw createTokenError("Microsoft token request failed", {
        kind: "NETWORK",
        code: "MICROSOFT_TOKEN_NETWORK_ERROR",
      });
    }

    try {
      if (!response || response.ok !== true) {
        throw createTokenError("Microsoft token request was rejected", {
          kind: "AUTHENTICATION",
          code: "MICROSOFT_TOKEN_REJECTED",
          status: Number.isInteger(response?.status) ? response.status : null,
        });
      }

      let tokenResponse;

      try {
        tokenResponse = await response.json();
      } catch {
        if (requestSignal.timedOut()) {
          throw createTokenError("Microsoft token request timed out", {
            kind: "TIMEOUT",
            code: "MICROSOFT_TOKEN_TIMEOUT",
          });
        }

        if (signal?.aborted || requestSignal.signal.aborted) {
          throw createTokenError("Microsoft token request was aborted", {
            kind: "ABORTED",
            code: "MICROSOFT_TOKEN_ABORTED",
          });
        }

        throw createTokenError("Microsoft token response was invalid", {
          kind: "RESPONSE",
          code: "INVALID_MICROSOFT_TOKEN_RESPONSE",
        });
      }

      if (!tokenResponse || typeof tokenResponse !== "object") {
        throw createTokenError("Microsoft token response was invalid", {
          kind: "RESPONSE",
          code: "INVALID_MICROSOFT_TOKEN_RESPONSE",
        });
      }

      const accessToken =
        typeof tokenResponse.access_token === "string"
          ? tokenResponse.access_token.trim()
          : "";
      const expiresIn = tokenResponse.expires_in;

      if (!accessToken) {
        throw createTokenError("Microsoft token response was invalid", {
          kind: "RESPONSE",
          code: "MISSING_MICROSOFT_ACCESS_TOKEN",
        });
      }

      if (
        !Number.isInteger(expiresIn) ||
        expiresIn <= 0 ||
        expiresIn > MAX_EXPIRES_IN_SECONDS
      ) {
        throw createTokenError("Microsoft token response was invalid", {
          kind: "RESPONSE",
          code: "INVALID_MICROSOFT_TOKEN_EXPIRY",
        });
      }

      const rotatedRefreshToken =
        typeof tokenResponse.refresh_token === "string"
          ? tokenResponse.refresh_token.trim()
          : "";
      const expiresAt = getCurrentTime() + expiresIn * 1_000;

      if (rotatedRefreshToken) {
        currentRefreshToken = rotatedRefreshToken;
      }

      cachedAccessToken = accessToken;
      accessTokenExpiresAt = expiresAt;

      return accessToken;
    } finally {
      requestSignal.cleanup();
    }
  }

  async function getAccessToken({ signal } = {}) {
    if (hasUsableCachedToken()) {
      return cachedAccessToken;
    }

    if (!pendingRefresh) {
      const refreshPromise = refreshAccessToken({ signal });
      const singleFlightPromise = refreshPromise.finally(() => {
        if (pendingRefresh === singleFlightPromise) {
          pendingRefresh = null;
        }
      });

      pendingRefresh = singleFlightPromise;
    }

    return pendingRefresh;
  }

  return getAccessToken;
}

module.exports = {
  DEFAULT_SAFETY_BUFFER_SECONDS,
  MAX_EXPIRES_IN_SECONDS,
  MicrosoftGraphTokenError,
  buildMicrosoftTokenEndpoint,
  createMicrosoftGraphTokenProvider,
};
