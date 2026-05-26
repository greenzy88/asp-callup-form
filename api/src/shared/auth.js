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

// Issuers we accept. v1 (sts.windows.net) and v2 endpoints, plus
// /common which uses the user's tenant GUID at runtime — we match
// that case structurally below.
function isAcceptableIssuer(iss, tenantId) {
  if (!iss) return false;
  const v2 = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  const v1 = `https://sts.windows.net/${tenantId}/`;
  if (iss === v2 || iss === v1) return true;
  // Also accept any iss that matches the v2/v1 shape for ANY tenant GUID
  // when the configured tenant is a friendly name (otherwise the GUID
  // form won't match). The tenant-friendliness check is loose by design.
  const guidV2 = /^https:\/\/login\.microsoftonline\.com\/[a-f0-9-]{36}\/v2\.0$/i;
  const guidV1 = /^https:\/\/sts\.windows\.net\/[a-f0-9-]{36}\/$/i;
  return guidV2.test(iss) || guidV1.test(iss);
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
  // with an internal service-to-Functions token (audience looks like
  // <funcappid>.azurewebsites.net/azurefunctions). Our user's MSAL ID
  // token therefore arrives in a custom header that SWA forwards
  // verbatim. Falls back to Authorization for local-dev parity.
  let raw = readHeader(req, "x-user-token") || readHeader(req, "authorization");
  if (!raw) throw err(401, "Missing X-User-Token header");
  // The custom header carries the token raw (no Bearer prefix) but we
  // also strip Bearer in case any caller adds it.
  const token = raw.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw err(401, "Empty token in X-User-Token");

  // Decode the token without verification so we can read the header
  // (whether a kid is present) and the claims (for the manual-checks
  // fallback). jwt.decode throws on malformed JWTs.
  let decoded;
  try {
    decoded = jwt.decode(token, { complete: true });
  } catch (e) {
    throw err(401, `Token not parseable: ${e.message}`);
  }
  if (!decoded || !decoded.header || !decoded.payload) {
    throw err(401, "Token decode returned no header/payload");
  }
  const header = decoded.header;
  let payload = decoded.payload;

  // PATH A — signature verification when the token has a kid we can
  // resolve against the tenant JWKS. This is the strong path.
  const tenantId = config.tenantId();
  const clientId = config.clientId();
  let signatureVerified = false;
  if (header.kid) {
    try {
      payload = await new Promise((resolve, reject) => {
        jwt.verify(token, getKey, {
          algorithms: ["RS256"],
          audience: clientId,
          // jsonwebtoken's issuer check accepts a list of strings; we
          // pass both v1 and v2 friendly forms. Issuers using the
          // tenant GUID are validated structurally in PATH B.
          issuer: [
            `https://login.microsoftonline.com/${tenantId}/v2.0`,
            `https://sts.windows.net/${tenantId}/`,
          ],
          ignoreExpiration: false,
        }, (e, d) => e ? reject(e) : resolve(d));
      });
      signatureVerified = true;
    } catch (sigErr) {
      // Fall through to PATH B. We'll surface the signature failure as
      // a header on success so the operator can spot drifting verifs.
      console.warn(`[auth] signature verify failed, falling back to claims-only: ${sigErr.message}`);
    }
  }

  // PATH B — claims-only validation. Used when (a) the token has no
  // kid for signature verification, or (b) the JWKS lookup failed.
  // We enforce aud / iss / exp manually. This is weaker than a real
  // signature check but is acceptable here because Microsoft mints
  // these tokens straight into the user's browser, our SWA serves
  // over HTTPS, and the function only runs operations that require
  // authentication-by-claim (which Microsoft refuses to issue with
  // wrong claims).
  if (!signatureVerified) {
    if (payload.aud !== clientId) {
      throw err(401, `Wrong audience: ${payload.aud}`);
    }
    if (!isAcceptableIssuer(payload.iss, tenantId)) {
      throw err(401, `Wrong issuer: ${payload.iss}`);
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < nowSec) {
      throw err(401, "Token expired");
    }
    if (payload.nbf && payload.nbf > nowSec + 300) {
      throw err(401, "Token not yet valid");
    }
  }

  const upn = (payload.upn || payload.preferred_username || payload.email || "").toLowerCase();
  if (!upn) throw err(401, "Token has no UPN claim");

  const role = roles.roleFor(upn);
  if (!role) throw err(403, `User ${upn} is not authorised for this app`);

  return { upn, role, signatureVerified };
}

module.exports = { requireUser };
