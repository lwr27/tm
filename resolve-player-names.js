// Resolves a display name AND club/clan tag for every unique accountId
// we've ever seen sitting in a division with one of the three tracked
// players — pulled from opponents.json's existing tallies, so this needs
// no fresh Nadeo calls, just trackmania.io's public player-profile lookup.
//
// This is deliberately a STANDALONE, reusable lookup file (players.json),
// separate from opponents.json — the idea is other features (clan tags on
// the Rivals tab, or anything else down the line) can just read this file
// by accountId rather than re-resolving names themselves.
//
// Resumable: already-resolved ids are skipped on a re-run, so as new
// opponents show up in future daily/backfill runs, just run this again
// and it'll only fetch names for the newly-added ids.
//
// Run with: npm run names
// No Nadeo credentials required — trackmania.io's player endpoint is public.

const fs = require("fs");
const path = require("path");

const OPPONENTS_PATH = path.join(__dirname, "opponents.json");
const OUT_PATH = path.join(__dirname, "players.json");
const TMIO_BASE = "https://trackmania.io/api";
const USER_AGENT = process.env.TM_USER_AGENT || "tm-cotd-tracker player-names / contact: lewis (github.com/lwr27/tm)";
const REQUEST_DELAY_MS = 550; // stay comfortably under the ~2 req/s community guideline
const SAVE_EVERY = 50; // write to disk periodically, not on every single request

let loggedFirstRawResponse = false;

// Fetches trackmania.io's player-profile endpoint for one accountId.
// Returns { name, clanTag } — either can be null if not present/resolvable.
async function resolvePlayer(accountId) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let res, body;
    try {
      res = await fetch(`${TMIO_BASE}/player/${accountId}`, { headers: { "User-Agent": USER_AGENT }, signal: controller.signal });
      if (res.ok) body = await res.json();
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok || !body) return { name: null, clanTag: null };

    // First-ever successful response gets logged in full so we can confirm
    // (once, by eye, in the Actions log) exactly which field the club tag
    // actually lives under before trusting the extraction below.
    if (!loggedFirstRawResponse) {
      loggedFirstRawResponse = true;
      console.log("\n--- Raw response for first resolved player (sanity check) ---");
      console.log(JSON.stringify(body, null, 2));
      console.log("--- end raw response ---\n");
    }

    // Defensive extraction — trackmania.io's player object shape isn't
    // formally documented, and may nest fields under `player`, or use
    // `tag` vs `clubTag` depending on endpoint. Try the plausible spots.
    const name = body.displayname || body.name || (body.player && body.player.name) || null;
    const clanTag = body.tag || body.clubTag || (body.player && body.player.tag) || (body.player && body.player.clubTag) || null;
    return { name, clanTag };
  } catch (e) {
    return { name: null, clanTag: null };
  }
}

async function main() {
  if (!fs.existsSync(OPPONENTS_PATH)) {
    console.error("opponents.json not found — run the opponents backfill first.");
    process.exit(1);
  }
  const opponents = JSON.parse(fs.readFileSync(OPPONENTS_PATH, "utf8"));

  // Union every accountId across all three players' opponent tallies.
  const allIds = new Set();
  Object.values(opponents.players || {}).forEach((tally) => {
    Object.keys(tally).forEach((id) => allIds.add(id));
  });
  console.log(`Found ${allIds.size} unique accountIds across all division opponents.`);

  // Resumable: load whatever's already resolved, skip those ids.
  let out = {};
  if (fs.existsSync(OUT_PATH)) {
    out = JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
    console.log(`Loaded ${Object.keys(out).length} already-resolved players from players.json.`);
  }

  const idsNeeded = [...allIds].filter((id) => !out[id]);
  console.log(`${idsNeeded.length} still need resolving.`);
  if (!idsNeeded.length) {
    console.log("Nothing to do. Done.");
    return;
  }

  let processed = 0;
  for (const accountId of idsNeeded) {
    const { name, clanTag } = await resolvePlayer(accountId);
    out[accountId] = { name, clanTag, resolvedAt: new Date().toISOString() };
    processed++;

    if (processed % SAVE_EVERY === 0 || processed === idsNeeded.length) {
      fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
      console.log(`[${processed}/${idsNeeded.length}] saved checkpoint...`);
    }

    await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`\nDone. ${processed} player(s) resolved this run, ${Object.keys(out).length} total in players.json.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
