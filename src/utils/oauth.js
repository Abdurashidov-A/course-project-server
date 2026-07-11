const jwt = require("jsonwebtoken");
const passport = require("passport");
const { Strategy: GoogleStrategy } = require("passport-google-oauth20");
const { Strategy: GitHubStrategy } = require("passport-github2");
const prisma = require("../lib/prisma");

const OAUTH_TOKEN_TTL_SECONDS = 60 * 5;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
function hasOAuthTokenSecret() {
  return Boolean(process.env.OAUTH_LOGIN_TOKEN_SECRET);
}

let strategiesInitialized = false;

function isGoogleConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_CALLBACK_URL &&
      hasOAuthTokenSecret(),
  );
}

function isGitHubConfigured() {
  return Boolean(
    process.env.GITHUB_CLIENT_ID &&
      process.env.GITHUB_CLIENT_SECRET &&
      process.env.GITHUB_CALLBACK_URL &&
      hasOAuthTokenSecret(),
  );
}

function isProviderConfigured(provider) {
  if (provider === "google") {
    return isGoogleConfigured();
  }

  if (provider === "github") {
    return isGitHubConfigured();
  }

  return false;
}

function getClientCallbackUrl() {
  const callbackUrl = new URL("/oauth/callback", CLIENT_URL);
  return callbackUrl.toString();
}

function getProviderProfileData(provider, profile) {
  const providerUserId = String(profile?.id || "");
  const displayName =
    profile?.displayName ||
    profile?.username ||
    `${provider} user`;
  const email =
    profile?.emails?.find((item) => item?.value)?.value ||
    `${provider}_${providerUserId}@oauth.local`;
  const avatarUrl = profile?.photos?.find((item) => item?.value)?.value || null;

  return {
    providerUserId,
    displayName,
    email,
    avatarUrl,
  };
}

async function ensureCandidateRole(tx) {
  return tx.role.findUnique({
    where: {
      name: "CANDIDATE",
    },
  });
}

async function findOrCreateOAuthUser(provider, profile) {
  const { providerUserId, displayName, email, avatarUrl } =
    getProviderProfileData(provider, profile);

  if (!providerUserId) {
    throw new Error("OAuth provider did not return a valid user id");
  }

  return prisma.$transaction(async (tx) => {
    const existingAccount = await tx.oAuthAccount.findUnique({
      where: {
        provider_providerUserId: {
          provider,
          providerUserId,
        },
      },
      include: {
        user: {
          include: {
            roles: {
              include: {
                role: true,
              },
            },
          },
        },
      },
    });

    if (existingAccount?.user) {
      await tx.oAuthAccount.update({
        where: {
          id: existingAccount.id,
        },
        data: {
          email,
          displayName,
          avatarUrl,
        },
      });

      return existingAccount.user;
    }

    let user = await tx.user.findUnique({
      where: {
        email,
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
      const createdUser = await tx.user.create({
        data: {
          email,
          name: displayName,
          avatarUrl,
        },
      });

      const candidateRole = await ensureCandidateRole(tx);

      if (!candidateRole) {
        throw new Error("Candidate role is missing");
      }

      await tx.userRole.create({
        data: {
          userId: createdUser.id,
          roleId: candidateRole.id,
        },
      });

      user = await tx.user.findUnique({
        where: {
          id: createdUser.id,
        },
        include: {
          roles: {
            include: {
              role: true,
            },
          },
        },
      });
    }

    await tx.oAuthAccount.create({
      data: {
        userId: user.id,
        provider,
        providerUserId,
        email,
        displayName,
        avatarUrl,
      },
    });

    return user;
  });
}

function createOAuthLoginToken(payload) {
  if (!process.env.OAUTH_LOGIN_TOKEN_SECRET) {
    throw new Error("OAuth provider is not configured.");
  }

  return jwt.sign(payload, process.env.OAUTH_LOGIN_TOKEN_SECRET, {
    expiresIn: OAUTH_TOKEN_TTL_SECONDS,
  });
}

function verifyOAuthLoginToken(token) {
  if (!process.env.OAUTH_LOGIN_TOKEN_SECRET) {
    throw new Error("OAuth provider is not configured.");
  }

  return jwt.verify(token, process.env.OAUTH_LOGIN_TOKEN_SECRET);
}

function initOAuthStrategies() {
  if (strategiesInitialized) {
    return;
  }

  strategiesInitialized = true;

  if (isGoogleConfigured()) {
    passport.use(
      "google",
      new GoogleStrategy(
        {
          clientID: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          callbackURL: process.env.GOOGLE_CALLBACK_URL,
        },
        async (_, __, profile, done) => {
          try {
            const user = await findOrCreateOAuthUser("google", profile);
            done(null, user);
          } catch (error) {
            done(error);
          }
        },
      ),
    );
  }

  if (isGitHubConfigured()) {
    passport.use(
      "github",
      new GitHubStrategy(
        {
          clientID: process.env.GITHUB_CLIENT_ID,
          clientSecret: process.env.GITHUB_CLIENT_SECRET,
          callbackURL: process.env.GITHUB_CALLBACK_URL,
          scope: ["user:email"],
        },
        async (_, __, profile, done) => {
          try {
            const user = await findOrCreateOAuthUser("github", profile);
            done(null, user);
          } catch (error) {
            done(error);
          }
        },
      ),
    );
  }
}

module.exports = {
  OAUTH_TOKEN_TTL_SECONDS,
  createOAuthLoginToken,
  getClientCallbackUrl,
  initOAuthStrategies,
  isProviderConfigured,
  verifyOAuthLoginToken,
};
