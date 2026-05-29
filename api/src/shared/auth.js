// Verify the MSAL ID token the SPA sends. Returns { upn, role } on
// success; throws an error whose `.status` is the HTTP code we should
// return on failure.
//
// SECURITY (2026-05-28): signature verification is MANDATORY. There is
// no claims-only fallback. A previous version (commit 9ac950a) accepted a
// token on aud/iss/exp claims alone whenever the RS256 signature could
// not be verified — which an attacker trivially triggers by sending an
// unsigned JWT (no `kid`). Because the SPA client ID is public (it ships
// in index.html) and the old issuer check accepted any GUID-shaped
// tenant, that fallback let an unauthenticated caller forge a token
// claiming to be any UPN (owner/manager included). The "No KID" symptom
// that motivated the fallback was actually caused by verifying SWA's
// internal service token from the Authorization header; commit 5fa8af09
// root-fixed that by reading the real MSAL ID token from x-user-token,
// which carries a resolvable kid. So the fallback is now both unnecessary
// and dangerous — removed. We reject anything we cannot cryptographically
// verify against the tenant JWKS.

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

function readHeader(req, name) {
  if (!req || !req.headers) return "";
  if (typeof req.headers.get === "function") {
    return req.headers.get(name) || "";
  }
  return req.headers[name] ||
         req.headers[name.toLowerCase()] ||
         req.headers[name.toUpperCase()] ||
         "";
}

async function requireUser(req) {
  // SWA's Managed Functions REWRITES the incoming Authorization header
  // with an internal service-to-Functions token, so the user's MSAL ID
  // token arrives in a custom header that SWA forwards verbatim. Falls
  // back to Authorization for local-dev parity.
  let raw = readHeader(req, "x-user-token") || readHeader(req, "authorization");
  if (!raw) throw err(401, "Missing X-User-Token header");
  const token = raw.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw err(401, "Empty token in X-User-Token");

  // Decode (unverified) only to read the header so we can confirm a kid
  // is present before verification. The decoded payload here is NEVER
  // trusted — jwt.verify below re-derives it from the verified signature.
  let header;
  try {
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || !decoded.header) throw new Error("no header");
    header = decoded.header;
  } catch (e) {
    throw err(401, `Token not parseable: ${e.message}`);
  }
  // A real Microsoft-issued token always carries a `kid`. No kid means we
  // cannot verify the signature, so we reject — there is no fallback.
  if (!header.kid) throw err(401, "Token has no kid; signature cannot be verified");

  const tenantId = config.tenantId();
  const clientId = config.clientId();

  // MANDATORY signature verification against the tenant JWKS. Issuer is
  // pinned to BOTH the v2 and v1 forms of the configured tenant. For this
  // to match real tokens, AAD_TENANT_ID MUST be the tenant GUID (not a
  // friendly *.onmicrosoft.com name) because Microsoft mints the `iss`
  // claim using the GUID even when the SPA authenticates via /common.
  let payload;
  try {
    payload = await new Promise((resolve, reject) => {
      jwt.verify(token, getKey, {
        algorithms: ["RS256"],
        audience: clientId,
        issuer: [
          `https://login.microsoftonline.com/${tenantId}/v2.0`,
          `https://sts.windows.net/${tenantId}/`,
        ],
        ignoreExpiration: false,
      }, (e, d) => e ? reject(e) : resolve(d));
    });
  } catch (sigErr) {
    throw err(401, `Token verification failed: ${sigErr.message}`);
  }

  // Defense in depth: the SPA authenticates via /common, so pin the tenant
  // explicitly via the `tid` claim in case the issuer list is ever widened.
  if (payload.tid && String(payload.tid).toLowerCase() !== String(tenantId).toLowerCase()) {
    throw err(401, `Token from unexpected tenant: ${payload.tid}`);
  }

  const upn = (payload.upn || payload.preferred_username || payload.email || "").toLowerCase();
  if (!upn) throw err(401, "Token has no UPN claim");

  const role = roles.roleFor(upn);
  if (!role) throw err(403, `User ${upn} is not authorised for this app`);

  return { upn, role, signatureVerified: true };
}

module.exports = { requireUser };
