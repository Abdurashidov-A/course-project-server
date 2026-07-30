const REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_CACHE_TTL_MS = 9 * 60 * 1000;

class SalesforceConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "SalesforceConfigError";
  }
}

class SalesforceRequestError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "SalesforceRequestError";
    this.status = options.status || null;
    this.code = options.code || null;
  }
}

function normalizeBaseUrl(value) {
  const normalized = typeof value === "string" ? value.trim() : "";

  if (!normalized) {
    return "";
  }

  let parsed;

  try {
    parsed = new URL(normalized);
  } catch {
    throw new SalesforceConfigError(
      "SALESFORCE_LOGIN_URL must be a valid HTTPS URL",
    );
  }

  if (
    parsed.protocol !== "https:" ||
    !/(^|\.)salesforce\.com$/i.test(parsed.hostname)
  ) {
    throw new SalesforceConfigError(
      "SALESFORCE_LOGIN_URL must use an HTTPS Salesforce domain",
    );
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";

  return parsed.toString().replace(/\/$/, "");
}

function getConfig(env) {
  const loginUrl = normalizeBaseUrl(env.SALESFORCE_LOGIN_URL);

  const clientId =
    typeof env.SALESFORCE_CLIENT_ID === "string"
      ? env.SALESFORCE_CLIENT_ID.trim()
      : "";

  const clientSecret =
    typeof env.SALESFORCE_CLIENT_SECRET === "string"
      ? env.SALESFORCE_CLIENT_SECRET.trim()
      : "";

  if (!loginUrl || !clientId || !clientSecret) {
    throw new SalesforceConfigError(
      "Salesforce integration environment variables are not configured",
    );
  }

  return {
    loginUrl,
    clientId,
    clientSecret,
  };
}

async function readResponseBody(response) {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function getErrorMeta(body) {
  const item = Array.isArray(body) ? body[0] : body;

  if (!item || typeof item !== "object") {
    return {
      message: "Salesforce request failed",
      code: null,
    };
  }

  return {
    message:
      typeof item.message === "string"
        ? item.message
        : typeof item.error_description === "string"
          ? item.error_description
          : "Salesforce request failed",

    code:
      typeof item.errorCode === "string"
        ? item.errorCode
        : typeof item.error === "string"
          ? item.error
          : null,
  };
}

function escapeSoqlString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function splitContactName(fullName) {
  const parts = String(fullName || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length <= 1) {
    return {
      firstName: null,
      lastName: (parts[0] || "Candidate").slice(0, 80),
    };
  }

  return {
    firstName: parts.shift().slice(0, 40),
    lastName: parts.join(" ").slice(0, 80),
  };
}

function getLatestApiVersion(versions) {
  if (!Array.isArray(versions)) {
    throw new SalesforceRequestError(
      "Salesforce returned an invalid API versions response",
    );
  }

  const latest = versions
    .filter(
      (version) =>
        version &&
        typeof version.version === "string" &&
        typeof version.url === "string",
    )
    .sort(
      (left, right) =>
        Number.parseFloat(right.version) -
        Number.parseFloat(left.version),
    )[0];

  if (!latest) {
    throw new SalesforceRequestError(
      "Salesforce did not return an available API version",
    );
  }

  return latest;
}

function createSalesforceClient(options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  const env = options.env || process.env;
  const now = options.now || Date.now;

  let cachedSession = null;

  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required");
  }

  async function fetchWithTimeout(url, init = {}) {
    const signal =
      typeof AbortSignal?.timeout === "function"
        ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        : undefined;

    try {
      return await fetchImpl(url, {
        ...init,
        signal: init.signal || signal,
      });
    } catch (error) {
      if (
        error?.name === "TimeoutError" ||
        error?.name === "AbortError"
      ) {
        throw new SalesforceRequestError(
          "Salesforce request timed out",
        );
      }

      throw new SalesforceRequestError(
        "Could not connect to Salesforce",
      );
    }
  }

  async function getNewSession() {
    const config = getConfig(env);
    const tokenUrl = `${config.loginUrl}/services/oauth2/token`;

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });

    const tokenResponse = await fetchWithTimeout(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    const tokenBody = await readResponseBody(tokenResponse);

    if (!tokenResponse.ok) {
      const errorMeta = getErrorMeta(tokenBody);

      throw new SalesforceRequestError(errorMeta.message, {
        status: tokenResponse.status,
        code: errorMeta.code,
      });
    }

    if (
      !tokenBody ||
      typeof tokenBody.access_token !== "string" ||
      typeof tokenBody.instance_url !== "string"
    ) {
      throw new SalesforceRequestError(
        "Salesforce returned an invalid access token response",
      );
    }

    const instanceUrl = normalizeBaseUrl(tokenBody.instance_url);

    const versionsResponse = await fetchWithTimeout(
      `${instanceUrl}/services/data/`,
      {
        headers: {
          Authorization: `Bearer ${tokenBody.access_token}`,
        },
      },
    );

    const versionsBody = await readResponseBody(versionsResponse);

    if (!versionsResponse.ok) {
      const errorMeta = getErrorMeta(versionsBody);

      throw new SalesforceRequestError(errorMeta.message, {
        status: versionsResponse.status,
        code: errorMeta.code,
      });
    }

    const latestVersion = getLatestApiVersion(versionsBody);

    cachedSession = {
      accessToken: tokenBody.access_token,
      instanceUrl,
      apiVersion: `v${latestVersion.version}`,
      expiresAt: now() + TOKEN_CACHE_TTL_MS,
    };

    return cachedSession;
  }

  async function getSession(forceRefresh = false) {
    if (
      !forceRefresh &&
      cachedSession &&
      cachedSession.expiresAt > now()
    ) {
      return cachedSession;
    }

    return getNewSession();
  }

  async function request(path, init = {}, allowRetry = true) {
    const session = await getSession();

    const response = await fetchWithTimeout(
      `${session.instanceUrl}/services/data/${session.apiVersion}${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          ...(init.body
            ? { "Content-Type": "application/json" }
            : {}),
          ...(init.headers || {}),
        },
      },
    );

    if (response.status === 401 && allowRetry) {
      cachedSession = null;
      await getSession(true);

      return request(path, init, false);
    }

    const body = await readResponseBody(response);

    if (!response.ok) {
      const errorMeta = getErrorMeta(body);

      throw new SalesforceRequestError(errorMeta.message, {
        status: response.status,
        code: errorMeta.code,
      });
    }

    return body;
  }

  async function query(soql) {
    return request(`/query?q=${encodeURIComponent(soql)}`);
  }

  async function findOrCreateAccount(accountName) {
    const queryResult = await query(
      `SELECT Id, Name FROM Account WHERE Name = '${escapeSoqlString(
        accountName,
      )}' LIMIT 1`,
    );

    const existingAccount = queryResult?.records?.[0];

    if (existingAccount?.Id) {
      return {
        id: existingAccount.Id,
        created: false,
      };
    }

    const createdAccount = await request("/sobjects/Account", {
      method: "POST",
      body: JSON.stringify({
        Name: accountName,
      }),
    });

    if (!createdAccount?.id) {
      throw new SalesforceRequestError(
        "Salesforce did not return the created Account id",
      );
    }

    return {
      id: createdAccount.id,
      created: true,
    };
  }

  async function findOrCreateContact({
    accountId,
    userName,
    email,
    phone,
  }) {
    const queryResult = await query(
      `SELECT Id, FirstName, LastName, Email, Phone, AccountId FROM Contact ` +
        `WHERE Email = '${escapeSoqlString(email)}' ` +
        `AND AccountId = '${escapeSoqlString(accountId)}' LIMIT 1`,
    );

    const existingContact = queryResult?.records?.[0];

    if (existingContact?.Id) {
      return {
        id: existingContact.Id,
        created: false,
      };
    }

    const { firstName, lastName } = splitContactName(userName);

    const contactPayload = {
      LastName: lastName,
      Email: String(email).slice(0, 80),
      AccountId: accountId,
      ...(firstName ? { FirstName: firstName } : {}),
      ...(phone
        ? { Phone: String(phone).slice(0, 40) }
        : {}),
    };

    const createdContact = await request("/sobjects/Contact", {
      method: "POST",
      body: JSON.stringify(contactPayload),
    });

    if (!createdContact?.id) {
      throw new SalesforceRequestError(
        "Salesforce did not return the created Contact id",
      );
    }

    return {
      id: createdContact.id,
      created: true,
    };
  }

  async function getConnectionStatus() {
    const session = await getSession();

    return {
      connected: true,
      instanceUrl: session.instanceUrl,
      apiVersion: session.apiVersion,
    };
  }

  async function exportProfile({
    userName,
    email,
    accountName,
    phone,
  }) {
    const account = await findOrCreateAccount(accountName);

    const contact = await findOrCreateContact({
      accountId: account.id,
      userName,
      email,
      phone,
    });

    return {
      account: {
        id: account.id,
        name: accountName,
        created: account.created,
      },
      contact,
    };
  }

  function clearCache() {
    cachedSession = null;
  }

  return {
    clearCache,
    exportProfile,
    getConnectionStatus,
  };
}

module.exports = {
  SalesforceConfigError,
  SalesforceRequestError,
  createSalesforceClient,
  escapeSoqlString,
  splitContactName,
};