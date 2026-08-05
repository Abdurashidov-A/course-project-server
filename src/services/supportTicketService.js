const { randomUUID } = require("node:crypto");
const { OneDriveGraphError } = require("../integrations/oneDriveGraphClient");

const ALLOWED_REQUEST_FIELDS = new Set([
  "summary",
  "priority",
  "positionId",
  "link",
]);

const ALLOWED_PRIORITIES = new Set(["High", "Average", "Low"]);
const ALLOWED_USER_ROLES = new Set(["CANDIDATE", "RECRUITER", "ADMIN"]);
const MIN_SUMMARY_LENGTH = 5;
const MAX_SUMMARY_LENGTH = 2_000;
const MAX_LINK_LENGTH = 2_048;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class SupportTicketError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "SupportTicketError";
    this.statusCode = options.statusCode || 500;
    this.code = options.code || "SUPPORT_TICKET_ERROR";
    this.publicCode = options.publicCode || null;
  }
}

function createSupportTicketError(statusCode, code, message) {
  return new SupportTicketError(message, {
    statusCode,
    code,
  });
}

function normalizeAllowedOrigins(origins) {
  const values = Array.isArray(origins) ? origins : [origins];

  return new Set(
    values
      .map((value) => {
        if (typeof value !== "string" || !value.trim()) {
          return null;
        }

        try {
          const parsed = new URL(value.trim());

          if (!['http:', 'https:'].includes(parsed.protocol)) {
            return null;
          }

          return parsed.origin;
        } catch {
          return null;
        }
      })
      .filter(Boolean),
  );
}

function validateSupportTicketRequest(body, allowedOrigins) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw createSupportTicketError(
      400,
      "INVALID_REQUEST_BODY",
      "Request body must be a JSON object",
    );
  }

  const unsupportedFields = Object.keys(body).filter(
    (field) => !ALLOWED_REQUEST_FIELDS.has(field),
  );

  if (unsupportedFields.length > 0) {
    throw createSupportTicketError(
      400,
      "UNSUPPORTED_REQUEST_FIELDS",
      "Request contains unsupported fields",
    );
  }

  const summary = typeof body.summary === "string" ? body.summary.trim() : "";

  if (summary.length < MIN_SUMMARY_LENGTH) {
    throw createSupportTicketError(
      400,
      "INVALID_SUMMARY",
      `Summary must contain at least ${MIN_SUMMARY_LENGTH} characters`,
    );
  }

  if (summary.length > MAX_SUMMARY_LENGTH) {
    throw createSupportTicketError(
      400,
      "INVALID_SUMMARY",
      `Summary must not exceed ${MAX_SUMMARY_LENGTH} characters`,
    );
  }

  if (!ALLOWED_PRIORITIES.has(body.priority)) {
    throw createSupportTicketError(
      400,
      "INVALID_PRIORITY",
      "Priority must be High, Average, or Low",
    );
  }

  let positionId = null;

  if (body.positionId !== undefined && body.positionId !== null) {
    if (!Number.isInteger(body.positionId) || body.positionId <= 0) {
      throw createSupportTicketError(
        400,
        "INVALID_POSITION_ID",
        "positionId must be a positive integer",
      );
    }

    positionId = body.positionId;
  }

  if (typeof body.link !== "string" || body.link.length > MAX_LINK_LENGTH) {
    throw createSupportTicketError(
      400,
      "INVALID_LINK",
      "Link must be a valid application URL",
    );
  }

  let parsedLink;

  try {
    parsedLink = new URL(body.link);
  } catch {
    throw createSupportTicketError(
      400,
      "INVALID_LINK",
      "Link must be a valid application URL",
    );
  }

  if (
    !["http:", "https:"].includes(parsedLink.protocol) ||
    parsedLink.username ||
    parsedLink.password ||
    !allowedOrigins.has(parsedLink.origin)
  ) {
    throw createSupportTicketError(
      400,
      "INVALID_LINK",
      "Link must belong to an allowed application origin",
    );
  }

  parsedLink.hash = "";

  return {
    summary,
    priority: body.priority,
    positionId,
    link: parsedLink.toString(),
  };
}

function normalizeRoleNames(roles) {
  if (!Array.isArray(roles)) {
    return [];
  }

  return [...new Set(
    roles
      .map((userRole) =>
        typeof userRole === "string" ? userRole : userRole?.role?.name,
      )
      .filter((roleName) => typeof roleName === "string" && roleName),
  )].sort((left, right) => left.localeCompare(right, "en"));
}

function normalizeAdminEmails(admins) {
  const uniqueEmails = new Map();

  for (const admin of admins || []) {
    const email = typeof admin?.email === "string" ? admin.email.trim() : "";

    if (!email || email.length > 320 || !EMAIL_PATTERN.test(email)) {
      continue;
    }

    const deduplicationKey = email.toLowerCase();

    if (!uniqueEmails.has(deduplicationKey)) {
      uniqueEmails.set(deduplicationKey, email);
    }
  }

  return [...uniqueEmails.values()].sort((left, right) =>
    left.localeCompare(right, "en", { sensitivity: "base" }),
  );
}

function normalizeReporterEmail(email) {
  if (typeof email !== "string") {
    return null;
  }

  const normalized = email.trim();

  return normalized || null;
}

function buildSupportTicketPayload({
  ticketId,
  createdAt,
  request,
  currentUser,
  position,
  adminEmails,
}) {
  return {
    schemaVersion: 1,
    ticketId,
    createdAt,
    summary: request.summary,
    priority: request.priority,
    reportedBy: {
      name: currentUser.name,
      email: normalizeReporterEmail(currentUser.email),
      roles: normalizeRoleNames(currentUser.roles),
    },
    position: position
      ? {
          id: position.id,
          title: position.title,
        }
      : null,
    link: request.link,
    adminEmails,
  };
}

function buildSupportTicketFilename(createdAt, ticketId) {
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt);

  if (Number.isNaN(date.getTime()) || !UUID_PATTERN.test(ticketId)) {
    throw new TypeError("A valid date and UUID are required");
  }

  const timestamp = date.toISOString().replace(/[-:.]/g, "");

  return `support-ticket-${timestamp}-${ticketId}.json`;
}

function mapUploadError(error) {
  if (!(error instanceof OneDriveGraphError)) {
    return createSupportTicketError(
      502,
      "ONEDRIVE_UPLOAD_FAILED",
      "Failed to submit support ticket",
    );
  }

  if (error.kind === "AUTHENTICATION" || error.kind === "CONFIGURATION") {
    return createSupportTicketError(
      503,
      "MICROSOFT_INTEGRATION_UNAVAILABLE",
      "Support ticket integration is not configured",
    );
  }

  if (error.kind === "THROTTLED") {
    return createSupportTicketError(
      503,
      "MICROSOFT_INTEGRATION_THROTTLED",
      "Support ticket integration is temporarily unavailable",
    );
  }

  return createSupportTicketError(
    502,
    "ONEDRIVE_UPLOAD_FAILED",
    "Failed to submit support ticket",
  );
}

function createSupportTicketService(options = {}) {
  const prismaClient = options.prismaClient;
  const getAccessToken = options.getAccessToken;
  const uploadJson = options.uploadJson;
  const driveId = typeof options.driveId === "string" ? options.driveId.trim() : "";
  const folderPath =
    typeof options.folderPath === "string" ? options.folderPath.trim() : "";
  const allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins || []);
  const now = options.now || (() => new Date());
  const createUuid = options.randomUUID || randomUUID;

  if (!prismaClient) {
    throw new TypeError("prismaClient is required");
  }

  async function submit({ userId, body, signal }) {
    if (typeof userId !== "string" || !userId.trim()) {
      throw createSupportTicketError(
        401,
        "AUTHENTICATION_REQUIRED",
        "Dev user id header is required",
      );
    }

    const currentUser = await prismaClient.user.findUnique({
      where: {
        id: userId.trim(),
      },
      include: {
        roles: {
          include: {
            role: true,
          },
        },
      },
    });

    if (!currentUser) {
      throw createSupportTicketError(
        401,
        "CURRENT_USER_NOT_FOUND",
        "Current user not found",
      );
    }

    if (currentUser.status === "BLOCKED") {
      throw createSupportTicketError(
        403,
        "CURRENT_USER_BLOCKED",
        "Current user is blocked",
      );
    }

    const currentUserRoles = normalizeRoleNames(currentUser.roles);

    if (!currentUserRoles.some((roleName) => ALLOWED_USER_ROLES.has(roleName))) {
      throw createSupportTicketError(
        403,
        "CURRENT_USER_ROLE_FORBIDDEN",
        "Current user role is not allowed",
      );
    }

    if (allowedOrigins.size === 0) {
      throw createSupportTicketError(
        503,
        "SUPPORT_TICKET_CONFIGURATION_MISSING",
        "Support ticket integration is not configured",
      );
    }

    const request = validateSupportTicketRequest(body, allowedOrigins);

    const [position, admins] = await Promise.all([
      request.positionId
        ? prismaClient.position.findUnique({
            where: {
              id: request.positionId,
            },
            select: {
              id: true,
              title: true,
            },
          })
        : Promise.resolve(null),
      prismaClient.user.findMany({
        where: {
          status: "ACTIVE",
          roles: {
            some: {
              role: {
                name: "ADMIN",
              },
            },
          },
        },
        select: {
          email: true,
        },
        orderBy: {
          email: "asc",
        },
      }),
    ]);

    if (request.positionId && !position) {
      throw createSupportTicketError(
        404,
        "POSITION_NOT_FOUND",
        "Position not found",
      );
    }

    const adminEmails = normalizeAdminEmails(admins);

    if (adminEmails.length === 0) {
      throw createSupportTicketError(
        503,
        "SUPPORT_RECIPIENTS_MISSING",
        "Support ticket recipients are not configured",
      );
    }

    if (
      typeof getAccessToken !== "function" ||
      typeof uploadJson !== "function" ||
      !driveId ||
      !folderPath
    ) {
      throw createSupportTicketError(
        503,
        "MICROSOFT_INTEGRATION_UNAVAILABLE",
        "Support ticket integration is not configured",
      );
    }

    const createdDate = new Date(now());
    const createdAt = createdDate.toISOString();
    const ticketId = createUuid();
    const filename = buildSupportTicketFilename(createdDate, ticketId);
    const content = buildSupportTicketPayload({
      ticketId,
      createdAt,
      request,
      currentUser,
      position,
      adminEmails,
    });

    let accessToken;

    try {
      accessToken = await getAccessToken({ signal });
    } catch {
      throw createSupportTicketError(
        503,
        "MICROSOFT_AUTHENTICATION_FAILED",
        "Support ticket integration is not configured",
      );
    }

    if (typeof accessToken !== "string" || !accessToken.trim()) {
      throw createSupportTicketError(
        503,
        "MICROSOFT_AUTHENTICATION_FAILED",
        "Support ticket integration is not configured",
      );
    }

    try {
      await uploadJson({
        accessToken: accessToken.trim(),
        driveId,
        folderPath,
        filename,
        content,
        signal,
      });
    } catch (error) {
      throw mapUploadError(error);
    }

    return {
      ticketId,
      createdAt,
      status: "submitted",
    };
  }

  return {
    submit,
  };
}

module.exports = {
  MAX_SUMMARY_LENGTH,
  MIN_SUMMARY_LENGTH,
  SupportTicketError,
  buildSupportTicketFilename,
  buildSupportTicketPayload,
  createSupportTicketService,
  normalizeAdminEmails,
  normalizeRoleNames,
  validateSupportTicketRequest,
};
