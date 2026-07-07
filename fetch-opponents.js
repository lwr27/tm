// Builds the "division opponents" leaderboard data: for every COTD one of
// the three players entered, who else was in their division — and, since
// we know final division placement, who they beat and who beat them.
//
// Run with: npm run opponents
//
// DATA MODEL: trackmania.io exposes a COTD's full division breakdown given
// its numeric COTD id (the `id` field already stored on each cached cup).
// One request per cup returns every division and its players, so we don't
// need the heavier Nadeo rounds->matches->results chain.
//
// "Beaten / lost to" is by final division rank (Option A): if you shared a
// division, whoever placed higher (lower divrank) beat the other.
//
// Output: opponents.json — per player, a tally keyed by opponent account
// id: { name, faced, beaten, lostTo }. Incremental: each cup is processed
// once (tracked in processedCups), so re-runs only handle new cups.

const fs = require("fs");
const path = require("path");

const BASE = "https://trackmania.io/api";
const USER_AGENT = process.env.TM_USER_AGENT || "tm-cotd-tracker division-opponents / contact: lewis (github.com/lwr27/tm)";
const CACHE_PATH = path.join(__dirname, "cache.json");
const OUT_PATH = path.join(__dirname, "opponents.json");

// XV27 alone (not merged with Whidot) — matches the account whose division
// we're actually reading. Whidot handled separately if ever needed.
const PLAYERS = [
  { name: "XV27", accountId: "8b537233-4931-49a8-af54-b0cefc33fa72" },
  { name: "TheBreaker0", accountId: "07859bb1-b0bd-4748-b1bb-4ecb173786c6" },
  { name: "Pho3nix_.", accountId: "ede8dd52-dc02-4abc-a864-eb6e3934bc2b" },
];
const OUR_IDS = new Set(PLAYERS.map((p) => p.accountId));

async function tmioFetch(url, maxRetries = 5) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res, body;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: controller.signal });
        if (res.ok) body = await res.json(); // read body under the same timeout
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      console.warn(`  request hung/failed (${err.name === "AbortError" ? "timed out" : err.message}), retrying (${attempt + 1}/${maxRetries})`);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = retryAfter ? retryAfter * 1000 : Math.min(30000, 2000 * 2 ** attempt);
      console.warn(`  rate limited (429), waiting ${Math.round(waitMs / 1000)}s (${attempt + 1}/${maxRetries})`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return body;
  }
  throw new Error(`${url} -> failed after ${maxRetries} retries`);
}

// Pulls the division rosters for a COTD by its trackmania.io id. Returns a
// map: divisionNumber -> [{ accountId, name, divRank }], or null if the
// endpoint has no usable data. The exact response shape is logged once (see
// probe) so we can adjust the field names if trackmania.io differs.
let probed = false;
async function getDivisions(cotdId) {
  // trackmania.io serves a COTD's results here; the response groups players
  // by division with each player's division rank.
  const data = await tmioFetch(`${BASE}/comp/${cotdId}/results`);
  if (!data) return null;
  if (!probed) {
    probed = true;
    console.log(`  Raw /comp/${cotdId}/results shape (first 600 chars):`);
    console.log("  " + JSON.stringify(data).slice(0, 600));
  }

  // Defensive parsing: accept a few plausible shapes. We want a flat list of
  // { player accountId, division, rank-in-division }.
  const rows = [];
  const list = Array.isArray(data) ? data
    : Array.isArray(data.results) ? data.results
    : Array.isArray(data.players) ? data.players
    : Array.isArray(data.tops) ? data.tops
    : [];
  list.forEach((r) => {
    const accountId = r.player?.id || r.accountId || r.playerId || r.id;
    const name = r.player?.name || r.name || null;
    const division = r.division ?? r.div ?? null;
    const divRank = r.divisionRank ?? r.divRank ?? r.rankInDivision ?? r.rank ?? null;
    if (accountId && division != null) rows.push({ accountId, name, division, divRank });
  });
  if (!rows.length) return null;

  const byDiv = {};
  rows.forEach((r) => { (byDiv[r.division] = byDiv[r.division] || []).push(r); });
  return byDiv;
}

function loadOut() {
  if (fs.existsSync(OUT_PATH)) {
    try { return JSON.parse(fs.readFileSync(OUT_PATH, "utf8")); } catch (e) { /* rebuild */ }
  }
  return { players: {}, processedCups: [], generatedAt: null };
}

function main() {
  if (!fs.existsSync(CACHE_PATH)) {
    console.error("cache.json not found — run `npm run update` first.");
    process.exit(1);
  }
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  const out = loadOut();
  out.players = out.players || {};
  const processed = new Set(out.processedCups || []);

  // XV27's cups are cached under the merged "XV27 & Whidot" key (see
  // fetch-data.js) — read from there, but tally opponents under the plain
  // "XV27" name since that's who we're actually asking about here.
  const CUP_SOURCE = {
    "XV27": "XV27 & Whidot",
    "TheBreaker0": "TheBreaker0",
    "Pho3nix_.": "Pho3nix_.",
  };
  const cupsById = {}; // cotdId -> { id, playersHere: [{accountId, division, divRank}] }
  PLAYERS.forEach((p) => {
    const cups = (cache.players[CUP_SOURCE[p.name]] && cache.players[CUP_SOURCE[p.name]].cups) || [];
    cups.forEach((c) => {
      if (c.id == null || c.div == null || c.divrank == null || c.divrank === 0) return; // must have actually played the division
      const entry = cupsById[c.id] || (cupsById[c.id] = { id: c.id, playersHere: [] });
      entry.playersHere.push({ accountId: p.accountId, name: p.name, division: c.div, divRank: c.divrank });
    });
  });

  const allIds = Object.keys(cupsById).filter((id) => !processed.has(id));
  console.log(`${Object.keys(cupsById).length} COTDs involve our players; ${allIds.length} still to process.\n`);

  const ensure = (name) => (out.players[name] = out.players[name] || {});
  const bump = (tally, oppId, oppName, field) => {
    const o = tally[oppId] || (tally[oppId] = { name: oppName, faced: 0, beaten: 0, lostTo: 0 });
    if (oppName && !o.name) o.name = oppName;
    o[field] += 1;
  };

  (async () => {
    let done = 0;
    for (const id of allIds) {
      done++;
      const cup = cupsById[id];
      process.stdout.write(`[${done}/${allIds.length}] COTD ${id} ... `);
      let byDiv;
      try {
        byDiv = await getDivisions(id);
      } catch (err) {
        console.log(`failed (${err.message}) — will retry on a later run`);
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      if (!byDiv) {
        console.log("no division data available — marking processed to avoid re-fetching");
        processed.add(id); out.processedCups = [...processed];
        fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }

      // For each of our players in this cup, look at everyone else in their
      // division and tally faced / beaten / lostTo by division rank.
      cup.playersHere.forEach((me) => {
        const roster = byDiv[me.division] || [];
        const tally = ensure(me.name);
        roster.forEach((opp) => {
          if (opp.accountId === me.accountId) return; // not myself
          bump(tally, opp.accountId, opp.name, "faced");
          if (opp.divRank != null && me.divRank != null) {
            if (me.divRank < opp.divRank) bump(tally, opp.accountId, opp.name, "beaten");
            else if (me.divRank > opp.divRank) bump(tally, opp.accountId, opp.name, "lostTo");
          }
        });
      });

      processed.add(id);
      out.processedCups = [...processed];
      out.generatedAt = new Date().toISOString();
      fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
      console.log("done");
      await new Promise((r) => setTimeout(r, 1200));
    }
    console.log(`\nFinished. ${processed.size} COTDs processed in total.`);
  })().catch((err) => { console.error(err); process.exit(1); });
}

main();
