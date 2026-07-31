const {
  createHash,
  randomBytes,
  timingSafeEqual,
} = require("node:crypto");

const TOKEN_PREFIX = "cvms_odoo_";
const TOKEN_RANDOM_BYTES = 32;
const TOKEN_PAYLOAD_LENGTH = 43;
const TOKEN_PATTERN = new RegExp(
  `^${TOKEN_PREFIX}[A-Za-z0-9_-]{${TOKEN_PAYLOAD_LENGTH}}$`,
);
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

function generateRawToken() {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_RANDOM_BYTES).toString("base64url")}`;
}

function hashToken(rawToken) {
  return createHash("sha256").update(rawToken).digest("hex");
}

function isValidTokenFormat(rawToken) {
  return typeof rawToken === "string" && TOKEN_PATTERN.test(rawToken);
}

function createTokenHint(rawToken) {
  if (!isValidTokenFormat(rawToken)) {
    return "";
  }

  return `...${rawToken.slice(-8)}`;
}

function verifyTokenHash(rawToken, storedHash) {
  if (
    !isValidTokenFormat(rawToken) ||
    typeof storedHash !== "string" ||
    !SHA256_HEX_PATTERN.test(storedHash)
  ) {
    return false;
  }

  const rawTokenHashBuffer = Buffer.from(hashToken(rawToken), "hex");
  const storedHashBuffer = Buffer.from(storedHash, "hex");

  if (rawTokenHashBuffer.length !== storedHashBuffer.length) {
    return false;
  }

  return timingSafeEqual(rawTokenHashBuffer, storedHashBuffer);
}

module.exports = {
  createTokenHint,
  generateRawToken,
  hashToken,
  isValidTokenFormat,
  verifyTokenHash,
};
