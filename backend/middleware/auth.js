const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "smart-clinic-dev-secret";
const ACCESS_TOKEN_TTL = process.env.JWT_ACCESS_EXPIRES_IN || "12h";
const REFRESH_TOKEN_TTL = process.env.JWT_REFRESH_EXPIRES_IN || "7d";

function signToken(payload, expiresIn = ACCESS_TOKEN_TTL) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

function signAccessToken(payload, expiresIn = ACCESS_TOKEN_TTL) {
  return signToken(payload, expiresIn);
}

function signRefreshToken(payload, expiresIn = REFRESH_TOKEN_TTL) {
  return jwt.sign({ ...payload, type: "refresh" }, JWT_SECRET, { expiresIn });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: "Unauthorized: token missing" });
  }

  try {
    req.user = verifyToken(token);
    return next();
  } catch (error) {
    return res.status(401).json({ message: "Unauthorized: invalid token" });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: "Forbidden: insufficient role" });
    }
    return next();
  };
}

module.exports = {
  signToken,
  signAccessToken,
  signRefreshToken,
  verifyToken,
  authenticate,
  requireRole
};
