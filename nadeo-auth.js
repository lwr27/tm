require("dotenv").config();

// Authenticates against Nadeo's real game API using a dedicated server
// account (separate login/password from your normal Ubisoft login —
// create one at https://player.trackmania.com/ under "Dedicated servers").
//
// This is a different, more restricted auth system than the trackmania.io
// stuff the rest of this project uses. Docs: https://webservices.openplanet.dev/auth/dedi
//
// Set NADEO_SERVER_LOGIN and NADEO_SERVER_PASSWORD as environment variables
// before running any script that needs this (don't hardcode them in a file
// that might get committed to git).

const USER_AGENT = process.env.TM_USER_AGENT || "tm-cotd-tracker author-medals / contact: lewis (github.com/lwr27/lab)";

const tokenCache = {}; // audience -> { accessToken, refreshToken, expiresAt }

async function login(audience) {
  const login = process.env.NADEO_SERVER_LOGIN;
  const password = process.env.NADEO_SERVER_PASSWORD;
  if (!login || !password) {
    throw new Error(
      "Missing NADEO_SERVER_LOGIN / NADEO_SERVER_PASSWORD environment variables. " +
      "Set these to your dedicated server account credentials (from https://player.trackmania.com/ " +
      "under Dedicated servers) before running this script."
    );
  }
  const basic = Buffer.from(`${login}:${password}`).toString("base64");
  const res = await fetch("https://prod.trackmania.core.nadeo.online/v2/authentication/token/basic", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${basic}`,
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({ audience }),
  });
  if (!res.ok) {
    throw new Error(`Nadeo login failed for audience ${audience}: HTTP ${res.status} — ${await res.text()}`);
  }
  const data = await res.json();
  tokenCache[audience] = {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: Date.now() + 55 * 60 * 1000, // tokens last ~1hr, refresh a bit early
  };
  return tokenCache[audience].accessToken;
}

async function refresh(audience) {
  const cached = tokenCache[audience];
  const res = await fetch("https://prod.trackmania.core.nadeo.online/v2/authentication/token/refresh", {
    method: "POST",
    headers: {
      "Authorization": `nadeo_v1 t=${cached.refreshToken}`,
      "User-Agent": USER_AGENT,
    },
  });
  if (!res.ok) throw new Error(`Token refresh failed for audience ${audience}: HTTP ${res.status}`);
  const data = await res.json();
  tokenCache[audience] = {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: Date.now() + 55 * 60 * 1000,
  };
  return tokenCache[audience].accessToken;
}

async function getToken(audience) {
  const cached = tokenCache[audience];
  if (cached && Date.now() < cached.expiresAt) return cached.accessToken;
  if (cached && cached.refreshToken) {
    try { return await refresh(audience); }
    catch (err) { console.warn(`Refresh failed for ${audience}, logging in fresh: ${err.message}`); }
  }
  return login(audience);
}

async function nadeoFetch(url, audience, maxRetries = 5) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const token = await getToken(audience);
    let res, body;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        res = await fetch(url, {
          headers: {
            "Authorization": `nadeo_v1 t=${token}`,
            "User-Agent": USER_AGENT,
          },
          signal: controller.signal,
        });
        if (res.ok) body = await res.json(); // body read covered by the same timeout
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      console.warn(`  Nadeo request hung/failed (${err.name === "AbortError" ? "timed out after 20s" : err.message}), retrying (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = retryAfter ? retryAfter * 1000 : Math.min(30000, 2000 * 2 ** attempt);
      console.warn(`  rate limited (429) on Nadeo, waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (!res.ok) {
      throw new Error(`${url} -> HTTP ${res.status} — ${await res.text()}`);
    }
    return body;
  }
  throw new Error(`${url} -> still failing after ${maxRetries} retries`);
}

module.exports = { nadeoFetch, getToken };
