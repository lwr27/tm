// Resolves a display name for every unique accountId we've ever seen
// sitting in a division with one of the three tracked players — pulled
// from opponents.json's existing tallies, so this needs no fresh Nadeo
// calls, just trackmania.io's public player-profile lookup.
//
// NOTE: confirmed via a live raw-response check that this endpoint does
// NOT include a clan/club tag (only accountid, displayname, trophies,
// matchmaking). Getting real clan tags would need Nadeo's clubTags
// endpoint, which requires Ubisoft-account OAuth rather than the
// dedicated-server credentials used elsewhere in this pipeline — a
// separate piece of work, not something this script can do. The
// clanTag field below is left in defensively in case that changes, but
// expect it to always come back null for now.
//
// This is deliberately a STANDALONE, reusable lookup file (players.json),
// separate from opponents.json — the idea is other features can just
// read this file by accountId rather than re-resolving names themselves.
//
// Resumable: already-resolved ids are skipped on a re-run, so as new
// opponents show up in future daily/backfill runs, just run this again
// and it'll only fetch names for the newly-added ids.
//
// Filtering: set MIN_FACED=<n> to only resolve accountIds that at least
// one player has faced >= n times (cuts out one-off strangers). Set
// STATS_ONLY=1 to just print the cutoff distribution without resolving
// anything, so you can pick a sensible MIN_FACED first.
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

let rawResponsesLogged = 0;
let sampledWithTag = 0;
const RAW_LOG_SAMPLE_SIZE = 15; // one response can't tell us whether a missing tag means "this player has none" vs "the field never exists" — need several to be confident

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

    const hasTagField = !!(body.tag || body.clubTag || (body.player && body.player.tag) || (body.player && body.player.clubTag));

    // Log the first several successful responses so we can eyeball whether
    // ANY of them carry a tag/clubTag field — one sample can't distinguish
    // "this endpoint never has it" from "this particular player has none".
    if (rawResponsesLogged < RAW_LOG_SAMPLE_SIZE) {
      rawResponsesLogged++;
      if (hasTagField) sampledWithTag++;
      console.log(`\n--- Raw response #${rawResponsesLogged}/${RAW_LOG_SAMPLE_SIZE} (${body.displayname || accountId}) — tag field present: ${hasTagField} ---`);
      console.log(JSON.stringify(body, null, 2));
      console.log("--- end raw response ---\n");
      if (rawResponsesLogged === RAW_LOG_SAMPLE_SIZE) {
        console.log(`\n>>> SAMPLE SUMMARY: ${sampledWithTag}/${RAW_LOG_SAMPLE_SIZE} sampled players had a tag/clubTag field on this endpoint. <<<\n`);
      }
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

  // Union every accountId across all three players' opponent tallies,
  // tracking the highest faced-count any single player has against them
  // (used for filtering below — a one-off stranger faced once by XV27
  // shouldn't force a resolve just because they also show up once for
  // TheBreaker0).
  const maxFacedById = new Map();
  Object.values(opponents.players || {}).forEach((tally) => {
    Object.entries(tally).forEach(([id, v]) => {
      const prev = maxFacedById.get(id) || 0;
      if (v.faced > prev) maxFacedById.set(id, v.faced);
    });
  });
  console.log(`Found ${maxFacedById.size} unique accountIds across all division opponents.`);

  // Always show the distribution — this tells you how many ids you'd be
  // resolving at various cutoffs, before committing to anything.
  const thresholds = [1, 2, 3, 5, 10, 20];
  console.log("\nHow many accountIds would be included at each minimum faced-count cutoff:");
  thresholds.forEach((t) => {
    const count = [...maxFacedById.values()].filter((f) => f >= t).length;
    console.log(`  faced >= ${t}: ${count}`);
  });

  if (process.env.STATS_ONLY === "1") {
    console.log("\nSTATS_ONLY=1 set — not resolving anything. Re-run with MIN_FACED=<n> to actually resolve.");
    return;
  }

  const MIN_FACED = Number(process.env.MIN_FACED || 1);
  console.log(`\nUsing MIN_FACED=${MIN_FACED} (set the MIN_FACED env var to change this).`);

  const allIds = [...maxFacedById.keys()].filter((id) => maxFacedById.get(id) >= MIN_FACED);

  // Resumable: load whatever's already resolved, skip those ids.
  let out = {};
  if (fs.existsSync(OUT_PATH)) {
    out = JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
    console.log(`Loaded ${Object.keys(out).length} already-resolved players from players.json.`);
  }

  const idsNeeded = allIds.filter((id) => !out[id]);
  console.log(`${idsNeeded.length} still need resolving (of ${allIds.length} matching the MIN_FACED filter).`);
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
