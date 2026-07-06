// Pulls new COTD results for the fixed roster and merges them into cache.json.
// Run with: npm run update
//
// Incremental: for each account, pages back from the most recent cup only
// until it hits one already in cache.json, then stops — so a normal run
// after the first one is fast, fetching only what's genuinely new.

const fs = require("fs");
const path = require("path");

const USER_AGENT = process.env.TM_USER_AGENT || "tm-cotd-tracker / contact: lewis (github.com/lwr27/lab)";
const BASE = "https://trackmania.io/api";
const CACHE_PATH = path.join(__dirname, "cache.json");

// XV27 and Whidot are the same person, two accounts merged into one entry.
const PLAYERS = [
  { name: "XV27 & Whidot", accountIds: ["8b537233-4931-49a8-af54-b0cefc33fa72", "df4b0114-d8f7-45c9-a95d-fb4000749fe1"] },
  { name: "TheBreaker0", accountIds: ["07859bb1-b0bd-4748-b1bb-4ecb173786c6"] },
  { name: "Pho3nix_.", accountIds: ["ede8dd52-dc02-4abc-a864-eb6e3934bc2b"] },
];

function cupLabel(c) {
  return c.name || new Date(c.timestamp).toLocaleDateString();
}

function cupId(c) {
  // cup.id is trackmania.io's own numeric ID for that cup, stable and unique.
  // Fall back to the label if it's ever missing.
  return c.id != null ? `id:${c.id}` : `label:${cupLabel(c)}`;
}

async function fetchAccountNewHistory(accountId, knownIds) {
  let all = [];
  let page = 0;
  const MAX_PAGES = 300;
  const MAX_RETRIES = 5;

  while (page < MAX_PAGES) {
    let res;
    let attempt = 0;
    let rateLimited = false;

    while (attempt <= MAX_RETRIES) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        res = await fetch(`${BASE}/player/${accountId}/cotd/${page}`, {
          headers: { "User-Agent": USER_AGENT },
          signal: controller.signal,
        });
        clearTimeout(timeout);
      } catch (err) {
        console.warn(`  page ${page}: request failed (${err.message}), stopping this account`);
        return all;
      }

      if (res.status === 429) {
        rateLimited = true;
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = retryAfter ? retryAfter * 1000 : Math.min(30000, 2000 * 2 ** attempt);
        console.warn(`  page ${page}: rate limited (429), waiting ${Math.round(waitMs / 1000)}s and retrying (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise((r) => setTimeout(r, waitMs));
        attempt += 1;
        continue;
      }
      rateLimited = false;
      break;
    }

    if (rateLimited) {
      console.warn(`  page ${page}: still rate limited after ${MAX_RETRIES} retries, stopping this account for now`);
      break;
    }
    if (!res.ok) {
      console.warn(`  page ${page}: HTTP ${res.status}, stopping this account`);
      break;
    }

    const data = await res.json();
    const cups = data.cups || [];
    if (cups.length === 0) break;

    // trackmania.io returns most-recent-first within each page. Stop as
    // soon as we see a cup we've already cached — everything after it on
    // later pages will already be known too.
    let hitKnown = false;
    for (const c of cups) {
      if (knownIds.has(cupId(c))) { hitKnown = true; break; }
      all.push(c);
    }
    if (hitKnown) {
      console.log(`  page ${page}: +${all.length} new cups, reached already-cached history, stopping`);
      break;
    }

    console.log(`  page ${page}: +${cups.length} new cups (running total ${all.length})`);
    if (cups.length < 25) break; // short page means we've reached the end of history
    page += 1;
    await new Promise((r) => setTimeout(r, 800));
  }
  return all;
}

function loadExistingCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return { generatedAt: null, players: {} };
  }
}

function saveCache(cache) {
  cache.generatedAt = new Date().toISOString();
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

function statsFromCups(cups) {
  if (!cups.length) return { total: 0 };
  const ranks = cups.map((c) => c.rank).filter((v) => v != null);
  const divs = cups.map((c) => c.div).filter((v) => v != null);
  const bestrank = ranks.length ? Math.min(...ranks) : null;
  const avgrank = ranks.length ? Math.round(ranks.reduce((a, b) => a + b, 0) / ranks.length) : null;
  const bestdiv = divs.length ? Math.min(...divs) : null;
  const totalwins = ranks.filter((r) => r === 1).length;
  const totaldivwins = cups.filter((c) => c.divrank === 1).length;
  let winstreak = 0;
  for (let i = cups.length - 1; i >= 0; i--) {
    if (cups[i].rank === 1) winstreak++;
    else break;
  }
  return { total: cups.length, bestrank, avgrank, bestdiv, totalwins, totaldivwins, winstreak };
}

async function main() {
  const cache = loadExistingCache();
  cache.players = cache.players || {};

  for (const p of PLAYERS) {
    console.log(`Fetching ${p.name}...`);
    try {
      const existingCups = (cache.players[p.name] && cache.players[p.name].cups) || [];
      const knownIds = new Set(existingCups.map(cupId));

      let newCups = [];
      for (const id of p.accountIds) {
        newCups = newCups.concat(await fetchAccountNewHistory(id, knownIds));
      }

      const combined = existingCups.concat(newCups);
      combined.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      const seen = new Set();
      const deduped = combined.filter((c) => {
        const key = cupId(c);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      cache.players[p.name] = { cups: deduped, stats: statsFromCups(deduped) };
      console.log(`  ${p.name}: +${newCups.length} new, ${deduped.length} total cups cached`);
    } catch (err) {
      console.error(`  Failed to fetch ${p.name}: ${err.message} — leaving previous cache entry (if any) untouched`);
    }
    // Save after every player so a crash or interrupt partway through
    // doesn't lose progress already made on earlier players.
    saveCache(cache);
    // Give trackmania.io's rate limiter time to reset before the next player.
    await new Promise((r) => setTimeout(r, 5000));
  }

  console.log(`\nWrote ${CACHE_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
