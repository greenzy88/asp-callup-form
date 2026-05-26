// Verify the MSAL access token the SPA sends in `Authorization: Bearer
// <token>`. Returns { upn, role } on success; throws an error whose
// `.status` is the HTTP code we should return on failure.

const jwt = require("jsonwebtoken");
const jwksClient = require("jwks-rsa");
const config = require("./config");
const roles = require("./roles");

// Cache one JWKS client per tenant (cheap; one tenant per deployment).
let _jwks = null;
function jwks() {
  if (_jwks) return _jwks;
  _jwks = jwksClient({
    jwksUri: `https://login.microsoftonline.com/${config.tenantId()}/discovery/v2.0/keys`,
    cache: true,
    cacheMaxAge: 10 * 60 * 1000,
    rateLimit: true,
    jwksRequestsPerMinute: 30,
  });
  return _jwks;
}

function getKey(header, cb) {
  jwks().getSigningKey(header.kid, (err, key) => {
    if (err) { cb(err); return; }
    cb(null, key.getPublicKey());
  });
}

function err(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

async function requireUser(req) {
  // Cope with both v3 (request.headers.get) and v4 (request.headers.Map) shapes.
  let raw = "";
  if (req.headers && typeof req.headers.get === "function") {
    raw = req.headers.get("authorization") || "";
  } else if (req.headers) {
    raw = req.headers.authorization || req.headers.Authorization || "";
  }
  if (!raw || !/^Bearer\s+/i.test(raw)) {
    throw err(401, "Missing Authorization Bearer header");
  }
  const token = raw.replace(/^Bearer\s+/i, "").trim();

  // Validate as an ID token: audience must be our app's clientId.
  // (We use ID tokens, not Graph access tokens, because access tokens
  // for v2 endpoints aren't generally validatable outside MS services.)
  let payload;
  try {
    payload = await new Promise((resolve, reject) => {
      jwt.verify(token, getKey, {
        algorithms: ["RS256"],
        audience: config.clientId(),
        issuer: [
          `https://login.microsoftonline.com/${config.tenantId()}/v2.0`,
          `https://sts.windows.net/${config.tenantId()}/`,
        ],
        ignoreExpiration: false,
      }, (e, decoded) => e ? reject(e) : resolve(decoded));
    });
  } catch (e) {
    throw err(401, `Token verification failed: ${e.message}`);
  }

  const upn = (payload.upn || payload.preferred_username || payload.email || "").toLowerCase();
  if (!upn) throw err(401, "Token has no UPN claim");

  const role = roles.roleFor(upn);
  if (!role) throw err(403, `User ${upn} is not authorised for this app`);

  return { upn, role };
}

module.exports = { requireUser };
