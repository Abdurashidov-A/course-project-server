const express = require("express");
const prisma = require("../lib/prisma");
const {
  SalesforceConfigError,
  SalesforceRequestError,
  createSalesforceClient,
} = require("../integrations/salesforceClient");

const defaultSalesforceClient = createSalesforceClient();

function getDevUserId(req) {
  return req.header("x-dev-user-id") || null;
}

function getRoleNames(user) {
  return user?.roles?.map((userRole) => userRole.role?.name) || [];
}

function isAdmin(user) {
  return getRoleNames(user).includes("ADMIN");
}

function normalizeProfileForm(body) {
  const accountName =
    typeof body?.accountName === "string" ? body.accountName.trim() : "";

  const phone =
    typeof body?.phone === "string" ? body.phone.trim() : "";

  if (accountName.length < 2 || accountName.length > 255) {
    return {
      error: "Account name must contain between 2 and 255 characters",
    };
  }

  if (phone.length > 40) {
    return {
      error: "Phone must not exceed 40 characters",
    };
  }

  return {
    value: {
      accountName,
      phone: phone || null,
    },
  };
}

function createSalesforceRouter(options = {}) {
  const router = express.Router();
  const prismaClient = options.prismaClient || prisma;

  const salesforceClient =
    options.salesforceClient || defaultSalesforceClient;

  async function requireAuthenticated(req, res) {
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

    return currentUser;
  }

  function handleSalesforceError(error, res, operation) {
    if (error instanceof SalesforceConfigError) {
      return res.status(503).json({
        message: "Salesforce integration is not configured",
      });
    }

    if (error instanceof SalesforceRequestError) {
      console.error(`${operation} Salesforce error:`, {
        status: error.status,
        code: error.code,
        message: error.message,
      });

      return res.status(502).json({
        message: "Salesforce integration request failed",
        code: error.code,
      });
    }

    console.error(`${operation} error:`, error);

    return res.status(500).json({
      message: "Salesforce integration failed",
    });
  }

  router.get("/status", async (req, res) => {
    try {
      const currentUser = await requireAuthenticated(req, res);

      if (!currentUser) {
        return;
      }

      const status = await salesforceClient.getConnectionStatus();

      res.json(status);
    } catch (error) {
      handleSalesforceError(
        error,
        res,
        "GET /api/integrations/salesforce/status",
      );
    }
  });

  router.post("/profiles/:userId", async (req, res) => {
    try {
      const currentUser = await requireAuthenticated(req, res);

      if (!currentUser) {
        return;
      }

      const targetUserId =
        typeof req.params.userId === "string"
          ? req.params.userId.trim()
          : "";

      if (!targetUserId) {
        return res.status(400).json({
          message: "Valid user id is required",
        });
      }

      if (currentUser.id !== targetUserId && !isAdmin(currentUser)) {
        return res.status(403).json({
          message:
            "Only the profile owner or an admin can add this user to Salesforce",
        });
      }

      const form = normalizeProfileForm(req.body);

      if (form.error) {
        return res.status(400).json({
          message: form.error,
        });
      }

      const targetUser = await prismaClient.user.findUnique({
        where: {
          id: targetUserId,
        },
        select: {
          id: true,
          name: true,
          email: true,
        },
      });

      if (!targetUser) {
        return res.status(404).json({
          message: "User not found",
        });
      }

      const salesforce = await salesforceClient.exportProfile({
        userName: targetUser.name,
        email: targetUser.email,
        accountName: form.value.accountName,
        phone: form.value.phone,
      });

      res.status(salesforce.contact.created ? 201 : 200).json({
        user: {
          id: targetUser.id,
          name: targetUser.name,
          email: targetUser.email,
        },
        salesforce,
      });
    } catch (error) {
      handleSalesforceError(
        error,
        res,
        "POST /api/integrations/salesforce/profiles/:userId",
      );
    }
  });

  return router;
}

module.exports = createSalesforceRouter();
module.exports.createSalesforceRouter = createSalesforceRouter;
module.exports.normalizeProfileForm = normalizeProfileForm;