const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createTokenHint,
  generateRawToken,
  hashToken,
  isValidTokenFormat,
  verifyTokenHash,
} = require("../src/integrations/odooService");

test("generates unique Odoo tokens in the expected format", () => {
  const firstToken = generateRawToken();
  const secondToken = generateRawToken();

  assert.notEqual(firstToken, secondToken);
  assert.equal(firstToken.startsWith("cvms_odoo_"), true);
  assert.equal(secondToken.startsWith("cvms_odoo_"), true);
  assert.equal(isValidTokenFormat(firstToken), true);
  assert.equal(isValidTokenFormat(secondToken), true);
});

test("hashes tokens as deterministic lowercase SHA-256 hex", () => {
  const firstToken = generateRawToken();
  const secondToken = generateRawToken();
  const firstHash = hashToken(firstToken);

  assert.match(firstHash, /^[a-f0-9]{64}$/);
  assert.equal(firstHash.length, 64);
  assert.equal(hashToken(firstToken), firstHash);
  assert.notEqual(hashToken(secondToken), firstHash);
});

test("creates a hint containing only the final eight token characters", () => {
  const rawToken = generateRawToken();
  const hint = createTokenHint(rawToken);

  assert.equal(hint, `...${rawToken.slice(-8)}`);
  assert.equal(hint.length, 11);
  assert.equal(hint.includes(rawToken), false);
});

test("validates the Odoo token format without throwing", () => {
  const validToken = generateRawToken();

  assert.equal(isValidTokenFormat(validToken), true);
  assert.equal(isValidTokenFormat(undefined), false);
  assert.equal(isValidTokenFormat(null), false);
  assert.equal(isValidTokenFormat(""), false);
  assert.equal(
    isValidTokenFormat(validToken.replace("cvms_odoo_", "wrong_")),
    false,
  );
  assert.equal(isValidTokenFormat(`${validToken}a`), false);
  assert.equal(isValidTokenFormat(validToken.slice(0, -1)), false);
  assert.equal(
    isValidTokenFormat(`${validToken.slice(0, -1)}!`),
    false,
  );
});

test("verifies matching hashes and rejects different tokens", () => {
  const rawToken = generateRawToken();
  const anotherToken = generateRawToken();
  const storedHash = hashToken(rawToken);

  assert.equal(verifyTokenHash(rawToken, storedHash), true);
  assert.equal(verifyTokenHash(anotherToken, storedHash), false);
});

test("returns false for malformed token and hash inputs", () => {
  const rawToken = generateRawToken();
  const storedHash = hashToken(rawToken);

  assert.equal(verifyTokenHash(undefined, storedHash), false);
  assert.equal(verifyTokenHash(null, storedHash), false);
  assert.equal(verifyTokenHash("invalid-token", storedHash), false);
  assert.equal(verifyTokenHash(rawToken, undefined), false);
  assert.equal(verifyTokenHash(rawToken, null), false);
  assert.equal(verifyTokenHash(rawToken, ""), false);
  assert.equal(verifyTokenHash(rawToken, storedHash.slice(0, -2)), false);
  assert.equal(verifyTokenHash(rawToken, "z".repeat(64)), false);
});
