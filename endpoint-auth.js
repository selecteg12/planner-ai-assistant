const { timingSafeEqual } = require("node:crypto");

function safeEqual(leftValue, rightValue) {
  if (typeof leftValue !== "string" || typeof rightValue !== "string") return false;
  const left = Buffer.from(leftValue);
  const right = Buffer.from(rightValue);
  return left.length === right.length && timingSafeEqual(left, right);
}

function validBearer(req, secret) {
  const header = req.headers?.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  return safeEqual(header.slice(7), secret);
}

module.exports = { safeEqual, validBearer };
