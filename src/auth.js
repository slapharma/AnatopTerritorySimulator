'use strict';
const crypto = require('crypto');

// HTTP Basic Auth gate. Allowed users/password come from env so no
// credential is committed to the repo.
function timingSafeEq(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function basicAuth(req, res, next) {
  const usersEnv = process.env.AUTH_USERS || '';
  const password = process.env.AUTH_PASSWORD || '';
  const allowedUsers = usersEnv.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!allowedUsers.length || !password) return next(); // no auth configured (local dev)

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [user, pass] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
    const userOk = allowedUsers.includes(String(user || '').toLowerCase());
    const passOk = pass && timingSafeEq(pass, password);
    if (userOk && passOk) return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Anatop Territory Evaluation", charset="UTF-8"');
  res.status(401).send('Authentication required.');
}

module.exports = { basicAuth };
