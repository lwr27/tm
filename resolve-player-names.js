// Resolves a display name AND clan/club tag for every unique accountId
// we've ever seen sitting in a division with one of the three tracked
// players — pulled from opponents.json's existing tallies, so this needs
// no fresh Nadeo calls, just trackmania.io's public player-profile lookup.
//
// CONFIRMED via live sampling: the field is "clubtag" (all lowercase),
// pre-formatted with Maniaplanet $-color codes same as map names — so
// formatTMName() in the dashboard can render it directly. Not every
// player has one (comes back null/absent if they don't).
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
// Speed: requests run through a small concurrent worker pool (see
// CONCURRENCY/TARGET_RATE_PER_SEC below) instead of one-at-a-time with a
// fixed delay — same overall courtesy rate ceiling, less wasted idle time
// per request, so noticeably faster wall-clock for a big backfill.
//
// Run with: npm run names
// No Nadeo credentials required — trackmania.io's player endpoint is public.

const fs = require("fs");
const path = require("path");

const OPPONENTS_PATH = path.join(__dirname, "opponents.json");
const OUT_PATH = path.join(__dirname, "players.json");
const TMIO_BASE = "https://trackmania.io/api";
const USER_AGENT = process.env.TM_USER_AGENT || "tm-cotd-tracker player-names / contact: lewis (github.com/lwr27/tm)";
const SAVE_EVERY = 50; // write to disk periodically, not on every single request

// Rate limiting: a shared "next available slot" reserved by whichever
// concurrent worker asks first, so total throughput across ALL workers
// stays under the limit — same idea as a fixed delay, just without the
// wasted idle time sequential requests had baked in.
//
// CONFIRMED (via TrackmaniaIo.ApiClient docs, screenshot check): the
// real limit without an API key is 40 requests/minute (~0.67/sec) — much
// stricter than the vague "~2/sec" community guideline this was
// originally set to. Exceeding it throws an exception per that doc, so
// this errs on the safe side of 40/min rather than pushing right up to it.
// An API key can raise this to 150/min, but it's not self-serve — you'd
// need to request one from "Miss" on the Openplanet Discord.
const TARGET_RATE_PER_SEC = 35 / 60; // slightly under 40/min for headroom
const INTERVAL_MS = 1000 / TARGET_RATE_PER_SEC;
const CONCURRENCY = 3;
let nextSlot = Date.now();
function reserveSlot() {
  const now = Date.now();
  const slot = Math.max(nextSlot, now);
  nextSlot = slot + INTERVAL_MS;
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, slot - now)));
}

let rawResponsesLogged = 0;
let sampledWithTag = 0;
const RAW_LOG_SAMPLE_SIZE = 15; // one response can't tell us whether a missing tag means "this player has none" vs "the field never exists" — need several to be confident

// Fetches trackmania.io's player-profile endpoint for one accountId.
// Returns { name, clanTag } — either can be null if not present/resolvable.
async function resolvePlayer(accountId) {
  await reserveSlot();
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

    // Confirmed via live sampling: the field is "clubtag" (all lowercase,
    // one word), matching "displayname" also being all-lowercase on this
    // endpoint — NOT "tag"/"clubTag" as first assumed. It comes pre-
    // formatted with Maniaplanet $-color codes, same as map names, so
    // formatTMName() in the dashboard can render it directly.
    const hasTagField = body.clubtag != null && body.clubtag !== "";

    if (rawResponsesLogged < RAW_LOG_SAMPLE_SIZE) {
      rawResponsesLogged++;
      if (hasTagField) sampledWithTag++;
      console.log(`\n--- Raw response #${rawResponsesLogged}/${RAW_LOG_SAMPLE_SIZE} (${body.displayname || accountId}) — clubtag present: ${hasTagField} ---`);
      console.log(JSON.stringify(body, null, 2));
      console.log("--- end raw response ---\n");
      if (rawResponsesLogged === RAW_LOG_SAMPLE_SIZE) {
        console.log(`\n>>> SAMPLE SUMMARY: ${sampledWithTag}/${RAW_LOG_SAMPLE_SIZE} sampled players had a clubtag. <<<\n`);
      }
    }

    const name = body.displayname || body.name || (body.player && body.player.name) || null;
    const clanTag = body.clubtag || (body.player && body.player.clubtag) || null;
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

  console.log(`\nResolving with ${CONCURRENCY} concurrent workers, capped at ~${TARGET_RATE_PER_SEC} requests/sec total.`);

  let processed = 0;
  let cursor = 0;
  let savePending = false;

  function maybeCheckpoint(force) {
    if (!force && processed % SAVE_EVERY !== 0) return;
    if (savePending) return; // avoid overlapping writes from concurrent workers
    savePending = true;
    fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
    console.log(`[${processed}/${idsNeeded.length}] saved checkpoint...`);
    savePending = false;
  }

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= idsNeeded.length) return;
      const accountId = idsNeeded[i];
      const { name, clanTag } = await resolvePlayer(accountId);
      out[accountId] = { name, clanTag, resolvedAt: new Date().toISOString() };
      processed++;
      maybeCheckpoint(false);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  maybeCheckpoint(true);
  console.log(`\nDone. ${processed} player(s) resolved this run, ${Object.keys(out).length} total in players.json.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
