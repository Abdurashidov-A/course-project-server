const express = require("express");
const passport = require("passport");
const prisma = require("../lib/prisma");
const {
  createOAuthLoginToken,
  getClientCallbackUrl,
  initOAuthStrategies,
  isProviderConfigured,
  verifyOAuthLoginToken,
} = require("../utils/oauth");
const { findDemoCredential } = require("../utils/demoCredentials");
const { serializeSafeUser } = require("../utils/safeUser");

const router = express.Router();

initOAuthStrategies();

function getProviderConfigError() {
  return {
    message: "OAuth provider is not configured.",
  };
}

function ensureProviderConfigured(provider, req, res) {
  if (isProviderConfigured(provider)) {
    return true;
  }

  if (req.headers.accept?.includes("text/html")) {
    const callbackUrl = new URL(getClientCallbackUrl());
    callbackUrl.searchParams.set("error", getProviderConfigError().message);
    res.redirect(callbackUrl.toString());
    return false;
  }

  res.status(500).json(getProviderConfigError());
  return false;
}

function startOAuth(provider, options = {}) {
  return (req, res, next) => {
    if (!ensureProviderConfigured(provider, req, res)) {
      return;
    }

    passport.authenticate(provider, {
      session: false,
      ...options,
    })(req, res, next);
  };
}

function handleOAuthCallback(provider) {
  return (req, res, next) => {
    if (!ensureProviderConfigured(provider, req, res)) {
      return;
    }

    passport.authenticate(provider, { session: false }, (error, user) => {
      if (error) {
        console.error(`OAuth ${provider} callback failed:`, error);
        return res.redirect(
          `${getClientCallbackUrl()}?error=${encodeURIComponent("OAuth login failed")}`,
        );
      }

      if (!user) {
        return res.redirect(
          `${getClientCallbackUrl()}?error=${encodeURIComponent("OAuth login failed")}`,
        );
      }

      if (user.status === "BLOCKED") {
        return res.redirect(
          `${getClientCallbackUrl()}?error=${encodeURIComponent("User is blocked")}`,
        );
      }

      const token = createOAuthLoginToken({
        userId: user.id,
        provider,
      });

      const callbackUrl = new URL(getClientCallbackUrl());
      callbackUrl.searchParams.set("token", token);

      return res.redirect(callbackUrl.toString());
    })(req, res, next);
  };
}

router.get(
  "/oauth/google",
  startOAuth("google", {
    scope: ["profile", "email"],
  }),
);

router.get("/oauth/google/callback", handleOAuthCallback("google"));

router.get("/oauth/github", startOAuth("github", { scope: ["user:email"] }));

router.get("/oauth/github/callback", handleOAuthCallback("github"));

router.post("/oauth/complete", async (req, res) => {
  try {
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";

    if (!token) {
      return res.status(400).json({
        message: "OAuth token is required",
      });
    }

    const payload = verifyOAuthLoginToken(token);

    const user = await prisma.user.findUnique({
      where: {
        id: payload.userId,
      },
      include: {
        roles: {
          include: {
            role: true,
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    if (user.status === "BLOCKED") {
      return res.status(403).json({
        message: "User is blocked",
      });
    }

    return res.json({
      user: serializeSafeUser(user),
    });
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        message: "OAuth token expired",
      });
    }

    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({
        message: "Invalid OAuth token",
      });
    }

    console.error("POST /api/auth/oauth/complete failed:", error);
    return res.status(500).json({
      message: error.message || "OAuth login failed",
    });
  }
});

router.post("/test-login", async (req, res) => {
  try {
    const credential = findDemoCredential(req.body?.login, req.body?.password);

    if (!credential) {
      return res.status(401).json({
        message: "Invalid login or password",
      });
    }

    const user = await prisma.user.findUnique({
      where: {
        email: credential.email,
      },
      include: {
        roles: {
          include: {
            role: true,
          },
        },
      },
    });

    if (!user) {
      return res.status(401).json({
        message: "Invalid login or password",
      });
    }

    if (user.status === "BLOCKED") {
      return res.status(403).json({
        message: "User is blocked",
      });
    }

    return res.json({
      user: serializeSafeUser(user),
    });
  } catch (error) {
    console.error("POST /api/auth/test-login failed:", error);
    return res.status(500).json({
      message: "Test login failed",
    });
  }
});

module.exports = router;
