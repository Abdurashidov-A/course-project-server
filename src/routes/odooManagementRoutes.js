const express = require("express");
const prisma = require("../lib/prisma");
const defaultTokenService = require("../integrations/odooService");
const {
  createOdooManagementCredentialMiddleware,
} = require("../middleware/odooManagementCredential");

const SAFE_TOKEN_SELECT = {
  tokenHint: true,
  version: true,
  revokedAt: true,
  createdAt: true,
  updatedAt: true,
};

function getDevUserId(req) {
  return req.header("x-dev-user-id") || null;
}

function getRoleNames(user) {
  return user?.roles?.map((userRole) => userRole.role?.name) || [];
}

function canManageOdooTokens(user) {
  const roleNames = getRoleNames(user);

  return roleNames.includes("RECRUITER") || roleNames.includes("ADMIN");
}

function isValidPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function serializeToken(token) {
  return {
    hint: token.tokenHint,
    status: token.revokedAt === null ? "ACTIVE" : "REVOKED",
    version: token.version,
    revokedAt: token.revokedAt,
    createdAt: token.createdAt,
    updatedAt: token.updatedAt,
  };
}

function getSafeErrorMeta(error) {
  const rawName = typeof error?.name === "string" ? error.name : "Error";
  const rawCode = typeof error?.code === "string" ? error.code : null;

  return {
    name: /^[A-Za-z0-9_]+$/.test(rawName) ? rawName : "Error",
    code: rawCode && /^[A-Z0-9_]+$/.test(rawCode) ? rawCode : null,
  };
}

function handleManagementError(error, res, operation) {
  if (error?.code === "P2002") {
    return res.status(409).json({
      message: "Odoo token already exists",
    });
  }

  if (error?.code === "P2025") {
    return res.status(409).json({
      message: "Odoo token version conflict",
    });
  }

  console.error(`${operation} failed`, getSafeErrorMeta(error));

  return res.status(500).json({
    message: "Failed to manage Odoo token",
  });
}

function createOdooManagementRouter(options = {}) {
  const router = express.Router();
  const prismaClient = options.prismaClient || prisma;
  const tokenService = options.tokenService || defaultTokenService;

  router.use(
    createOdooManagementCredentialMiddleware({
      configuredCredential: options.managementCredential,
    }),
  );

  async function requireManager(req, res) {
    const userId = getDevUserId(req);

    if (!userId) {
      res.status(401).json({
        message: "Dev user id header is required",
      });
      return null;
    }

    const currentUser = await prismaClient.user.findUnique({
      where: {
        id: userId,
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
      res.status(401).json({
        message: "Current user not found",
      });
      return null;
    }

    if (currentUser.status === "BLOCKED") {
      res.status(403).json({
        message: "Current user is blocked",
      });
      return null;
    }

    if (!canManageOdooTokens(currentUser)) {
      res.status(403).json({
        message: "Only recruiters/admins can manage Odoo tokens",
      });
      return null;
    }

    return currentUser;
  }

  async function getAuthorizedPosition(req, res) {
    const currentUser = await requireManager(req, res);

    if (!currentUser) {
      return null;
    }

    const positionId = Number(req.params.positionId);

    if (!isValidPositiveInteger(positionId)) {
      res.status(400).json({
        message: "Valid position id is required",
      });
      return null;
    }

    const position = await prismaClient.position.findUnique({
      where: {
        id: positionId,
      },
      select: {
        id: true,
      },
    });

    if (!position) {
      res.status(404).json({
        message: "Position not found",
      });
      return null;
    }

    return {
      currentUser,
      positionId,
    };
  }

  router.get("/:positionId/odoo-token", async (req, res) => {
    try {
      const context = await getAuthorizedPosition(req, res);

      if (!context) {
        return;
      }

      const token = await prismaClient.positionOdooToken.findUnique({
        where: {
          positionId: context.positionId,
        },
        select: SAFE_TOKEN_SELECT,
      });

      res.json({
        positionId: context.positionId,
        token: token ? serializeToken(token) : null,
      });
    } catch (error) {
      handleManagementError(
        error,
        res,
        "GET /api/positions/:positionId/odoo-token",
      );
    }
  });

  router.post("/:positionId/odoo-token", async (req, res) => {
    try {
      const context = await getAuthorizedPosition(req, res);

      if (!context) {
        return;
      }

      const existingToken = await prismaClient.positionOdooToken.findUnique({
        where: {
          positionId: context.positionId,
        },
        select: SAFE_TOKEN_SELECT,
      });

      const hasVersion = Object.prototype.hasOwnProperty.call(
        req.body || {},
        "version",
      );

      if (!existingToken && hasVersion) {
        return res.status(409).json({
          message: "Odoo token version conflict",
        });
      }

      if (existingToken && !isValidPositiveInteger(req.body?.version)) {
        return res.status(400).json({
          message: "Valid version is required",
        });
      }

      const rawToken = tokenService.generateRawToken();
      const tokenHash = tokenService.hashToken(rawToken);
      const tokenHint = tokenService.createTokenHint(rawToken);

      let token;
      let statusCode;

      if (!existingToken) {
        token = await prismaClient.positionOdooToken.create({
          data: {
            positionId: context.positionId,
            tokenHash,
            tokenHint,
            createdById: context.currentUser.id,
          },
          select: SAFE_TOKEN_SELECT,
        });
        statusCode = 201;
      } else {
        token = await prismaClient.positionOdooToken.update({
          where: {
            positionId: context.positionId,
            version: req.body.version,
          },
          data: {
            tokenHash,
            tokenHint,
            revokedAt: null,
            version: {
              increment: 1,
            },
          },
          select: SAFE_TOKEN_SELECT,
        });
        statusCode = 200;
      }

      res.set("Cache-Control", "no-store");
      res.status(statusCode).json({
        positionId: context.positionId,
        rawToken,
        token: serializeToken(token),
      });
    } catch (error) {
      handleManagementError(
        error,
        res,
        "POST /api/positions/:positionId/odoo-token",
      );
    }
  });

  router.patch("/:positionId/odoo-token/revoke", async (req, res) => {
    try {
      const context = await getAuthorizedPosition(req, res);

      if (!context) {
        return;
      }

      if (!isValidPositiveInteger(req.body?.version)) {
        return res.status(400).json({
          message: "Valid version is required",
        });
      }

      const existingToken = await prismaClient.positionOdooToken.findUnique({
        where: {
          positionId: context.positionId,
        },
        select: SAFE_TOKEN_SELECT,
      });

      if (!existingToken) {
        return res.status(404).json({
          message: "Odoo token not found",
        });
      }

      const token = await prismaClient.positionOdooToken.update({
        where: {
          positionId: context.positionId,
          version: req.body.version,
        },
        data: {
          revokedAt: new Date(),
          version: {
            increment: 1,
          },
        },
        select: SAFE_TOKEN_SELECT,
      });

      res.json({
        positionId: context.positionId,
        token: serializeToken(token),
      });
    } catch (error) {
      handleManagementError(
        error,
        res,
        "PATCH /api/positions/:positionId/odoo-token/revoke",
      );
    }
  });

  return router;
}

module.exports = createOdooManagementRouter();
module.exports.createOdooManagementRouter = createOdooManagementRouter;
