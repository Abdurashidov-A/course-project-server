const { createHash, timingSafeEqual } = require("node:crypto");

const MANAGEMENT_CREDENTIAL_HEADER = "x-odoo-management-credential";

function createDigest(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

function hasConfiguredCredential(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function createOdooManagementCredentialMiddleware(options = {}) {
  const configuredCredential = options.configuredCredential;
  const configuredDigest = hasConfiguredCredential(configuredCredential)
    ? createDigest(configuredCredential)
    : null;

  return function requireOdooManagementCredential(req, res, next) {
    if (!configuredDigest) {
      return res.status(503).json({
        message: "Odoo management API is unavailable",
      });
    }

    const requestCredential = req.get(MANAGEMENT_CREDENTIAL_HEADER);

    if (
      typeof requestCredential !== "string" ||
      requestCredential.length === 0
    ) {
      return res.status(401).json({
        message: "Invalid management credential",
      });
    }

    const requestDigest = createDigest(requestCredential);
    const isValid =
      requestDigest.length === configuredDigest.length &&
      timingSafeEqual(requestDigest, configuredDigest);

    if (!isValid) {
      return res.status(401).json({
        message: "Invalid management credential",
      });
    }

    return next();
  };
}

module.exports = {
  createOdooManagementCredentialMiddleware,
};
