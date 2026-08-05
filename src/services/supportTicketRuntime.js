const {
  createOneDriveGraphClient,
} = require("../integrations/oneDriveGraphClient");
const {
  createMicrosoftGraphTokenProvider,
} = require("../integrations/microsoftGraphTokenProvider");
const { createSupportTicketRouter } = require("../routes/supportTicketRoutes");
const {
  SupportTicketError,
  createSupportTicketService,
} = require("./supportTicketService");

const NOT_CONFIGURED_CODE = "SUPPORT_TICKETS_NOT_CONFIGURED";
const NOT_CONFIGURED_MESSAGE =
  "Support ticket delivery is temporarily unavailable";

function isSupportTicketsEnabled(value) {
  return value === true || value === "true";
}

function splitOrigins(...values) {
  return values
    .flatMap((value) => (typeof value === "string" ? value.split(",") : []))
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeConfigurationValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function createUnavailableService() {
  return {
    async submit() {
      throw new SupportTicketError(NOT_CONFIGURED_MESSAGE, {
        statusCode: 503,
        code: NOT_CONFIGURED_CODE,
        publicCode: NOT_CONFIGURED_CODE,
      });
    },
  };
}

function createSupportTicketRuntimeRouter(options = {}) {
  const env = options.env || process.env;
  const enabled =
    options.enabled === undefined
      ? isSupportTicketsEnabled(env.SUPPORT_TICKETS_ENABLED)
      : isSupportTicketsEnabled(options.enabled);

  if (!enabled) {
    return createSupportTicketRouter({
      supportTicketService: createUnavailableService(),
    });
  }

  const allowedOrigins =
    options.allowedOrigins || splitOrigins(env.CLIENT_URL, env.CLIENT_ORIGIN);
  const driveId = normalizeConfigurationValue(
    options.driveId ?? env.MICROSOFT_ONEDRIVE_DRIVE_ID,
  );
  const folderPath = normalizeConfigurationValue(
    options.folderPath ?? env.ONEDRIVE_SUPPORT_FOLDER,
  );

  if (
    !options.prismaClient ||
    !driveId ||
    !folderPath ||
    allowedOrigins.length === 0
  ) {
    return createSupportTicketRouter({
      supportTicketService: createUnavailableService(),
    });
  }

  let getAccessToken = options.getAccessToken;

  if (typeof getAccessToken !== "function") {
    const tenantId = normalizeConfigurationValue(
      options.tenantId ?? env.MICROSOFT_TENANT_ID,
    );
    const clientId = normalizeConfigurationValue(
      options.clientId ?? env.MICROSOFT_CLIENT_ID,
    );
    const clientSecret = normalizeConfigurationValue(
      options.clientSecret ?? env.MICROSOFT_CLIENT_SECRET,
    );
    const refreshToken = normalizeConfigurationValue(
      options.refreshToken ?? env.MICROSOFT_REFRESH_TOKEN,
    );

    if (!tenantId || !clientId || !clientSecret || !refreshToken) {
      return createSupportTicketRouter({
        supportTicketService: createUnavailableService(),
      });
    }

    const tokenProviderFactory =
      options.tokenProviderFactory || createMicrosoftGraphTokenProvider;

    try {
      getAccessToken = tokenProviderFactory({
        tenantId,
        clientId,
        clientSecret,
        refreshToken,
        scopes: options.scopes ?? env.MICROSOFT_GRAPH_SCOPES,
        fetchImpl: options.tokenFetchImpl || options.fetchImpl,
        timeoutMs: options.tokenTimeoutMs,
        safetyBufferSeconds: options.tokenSafetyBufferSeconds,
        now: options.tokenNow,
      });
    } catch {
      return createSupportTicketRouter({
        supportTicketService: createUnavailableService(),
      });
    }

    if (typeof getAccessToken !== "function") {
      return createSupportTicketRouter({
        supportTicketService: createUnavailableService(),
      });
    }
  }

  const uploadJson =
    options.uploadJson ||
    createOneDriveGraphClient({
      fetchImpl: options.graphFetchImpl || options.fetchImpl,
      timeoutMs: options.graphTimeoutMs || options.timeoutMs,
      graphBaseUrl: options.graphBaseUrl,
    }).uploadJson;
  const supportTicketService = createSupportTicketService({
    prismaClient: options.prismaClient,
    getAccessToken,
    uploadJson,
    driveId,
    folderPath,
    allowedOrigins,
    now: options.now,
    randomUUID: options.randomUUID,
  });

  return createSupportTicketRouter({ supportTicketService });
}

module.exports = {
  NOT_CONFIGURED_CODE,
  NOT_CONFIGURED_MESSAGE,
  createSupportTicketRuntimeRouter,
  isSupportTicketsEnabled,
};
