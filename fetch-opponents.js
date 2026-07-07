// Builds the "division opponents" data: for every COTD one of the three
// players entered and actually played their division rounds in, who else
// was in that division — and since we know final division rank, who they
// beat and who beat them (Option A: higher division rank = the winner).
//
// Run with: npm run opponents
// Requires .env with NADEO_SERVER_LOGIN / NADEO_SERVER_PASSWORD.
//
// VERIFIED CHAIN (see probe-opponents.js for how this was confirmed):
//   1. A cup's trackmania.io `id` IS Nadeo's `competitionId` directly.
//   2. GET competitions/{id}/rounds -> one round per daily COTD.
//   3. GET rounds/{roundId}/matches?length=100&offset=0 -> up to ~29
//      matches; each match's `position` is (division - 1), e.g. "Match 8"
//      has position 7. Nadeo defaults to 10/page without the length param.
//   4. GET matches/{matchId}/results?length=100&offset=0 -> the full
//      division roster: { participant: accountId, rank: divisionRank }.
//      Same pagination default applies (confirmed: a 64-player division
//      only returned 10 rows without it). rank is null for players who
//      qualified but never played their rounds — skip those.
//
// Output: opponents.json — per player, a tally keyed by opponent account
// id: { name, faced, beaten, lostTo }. Incremental via processedCups.

const fs = require("fs");
const path = require("path");
const { nadeoFetch } = require("./nadeo-auth");

const LIVE = "NadeoLiveServices";
const CACHE_PATH = path.join(__dirname, "cache.json");
const OUT_PATH = path.join(__dirname, "opponents.json");
const TMIO_BASE = "https://trackmania.io/api";
const USER_AGENT = process.env.TM_USER_AGENT || "tm-cotd-tracker division-opponents / contact: lewis (github.com/lwr27/tm)";

// Nadeo's match results only give raw account IDs, no display name (the
// direct name-lookup endpoint was deprecated in 2023). trackmania.io's
// public player-profile endpoint can resolve one, so we look each unique
// opponent up once ever and cache the result in opponents.json — the same
// community regulars reappear across hundreds of cups, so after the
// initial backfill this cost drops to near zero.
async function resolvePlayerName(accountId) {
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
    if (!res.ok) return null;
    return body && body.displayname || body && body.name || null;
  } catch (e) {
    return null; // non-fatal — the leaderboard can show a shortened id as fallback
  }
}

const PLAYERS = [
  { name: "XV27", accountId: "8b537233-4931-49a8-af54-b0cefc33fa72" },
  { name: "TheBreaker0", accountId: "07859bb1-b0bd-4748-b1bb-4ecb173786c6" },
  { name: "Pho3nix_.", accountId: "ede8dd52-dc02-4abc-a864-eb6e3934bc2b" },
];
// XV27's cups are cached under the merged "XV27 & Whidot" key.
const CUP_SOURCE = { "XV27": "XV27 & Whidot", "TheBreaker0": "TheBreaker0", "Pho3nix_.": "Pho3nix_." };

function loadOut() {
  if (fs.existsSync(OUT_PATH)) {
    try { return JSON.parse(fs.readFileSync(OUT_PATH, "utf8")); } catch (e) { /* rebuild */ }
  }
  return { players: {}, names: {}, processedCups: [], generatedAt: null };
}

async function getDivisionRoster(competitionId, division) {
  const rounds = await nadeoFetch(
    `https://meet.trackmania.nadeo.club/api/competitions/${competitionId}/rounds`,
    LIVE
  );
  const roundId = Array.isArray(rounds) && rounds[0] && rounds[0].id;
  if (!roundId) return null;

  const matchesResp = await nadeoFetch(
    `https://meet.trackmania.nadeo.club/api/rounds/${roundId}/matches?length=100&offset=0`,
    LIVE
  );
  const matches = Array.isArray(matchesResp) ? matchesResp : (matchesResp && matchesResp.matches) || [];
  if (!matches.length) return null;

  const wantPosition = division - 1;
  const match = matches.find((m) => m.position === wantPosition);
  if (!match) return null;

  const results = await nadeoFetch(
    `https://meet.trackmania.nadeo.club/api/matches/${match.id}/results?length=100&offset=0`,
    LIVE
  );
  const list = Array.isArray(results) ? results : (results && (results.results || results.players)) || [];
  // skip null-rank rows: qualified into the division but never played it
  return list.filter((r) => r.rank != null).map((r) => ({ accountId: r.participant, rank: r.rank }));
}

function main() {
  if (!fs.existsSync(CACHE_PATH)) {
    console.error("cache.json not found — run `npm run update` first.");
    process.exit(1);
  }
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  const out = loadOut();
  out.players = out.players || {};
  out.names = out.names || {};
  const processed = new Set(out.processedCups || []);

  // Group by competition id (== cup.id) so a cup shared by 2-3 of our
  // players only costs one rounds+matches lookup, even if their divisions
  // differ and each needs its own results call.
  const cupsById = {};
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
  const bump = (tally, oppId, field) => {
    const o = tally[oppId] || (tally[oppId] = { faced: 0, beaten: 0, lostTo: 0 });
    o[field] += 1;
  };

  (async () => {
    let done = 0;
    for (const id of allIds) {
      done++;
      const cup = cupsById[id];
      process.stdout.write(`[${done}/${allIds.length}] competition ${id} ... `);

      // group this cup's our-players by division, so we only fetch each
      // distinct division roster once even if 2 of us shared it
      const divisionsNeeded = [...new Set(cup.playersHere.map((p) => p.division))];
      const rosterByDiv = {};
      let failed = false;
      for (const div of divisionsNeeded) {
        try {
          rosterByDiv[div] = await getDivisionRoster(id, div);
        } catch (err) {
          console.log(`\n  division ${div} failed (${err.message.slice(0, 100)}) — will retry this cup on a later run`);
          failed = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 900));
      }
      if (failed) { await new Promise((r) => setTimeout(r, 1500)); continue; }

      cup.playersHere.forEach((me) => {
        const roster = rosterByDiv[me.division];
        if (!roster) return;
        const tally = ensure(me.name);
        roster.forEach((opp) => {
          if (opp.accountId === me.accountId) return;
          bump(tally, opp.accountId, "faced");
          if (me.divRank < opp.rank) bump(tally, opp.accountId, "beaten");
          else if (me.divRank > opp.rank) bump(tally, opp.accountId, "lostTo");
        });
      });

      processed.add(id);
      out.processedCups = [...processed];
      out.generatedAt = new Date().toISOString();
      fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
      console.log("done");
      await new Promise((r) => setTimeout(r, 900));
    }
    console.log(`\nFinished tallying. ${processed.size} COTDs processed in total.`);

    // Name resolution happens LAST and only for whoever actually matters:
    // the top 20 by faced-count per player. Resolving every one-off
    // opponent ever shared with would be thousands of extra requests for
    // names nobody will see; this is a few dozen at most, however many
    // cups were processed.
    const TOP_N = 20;
    const idsNeeded = new Set();
    Object.values(out.players).forEach((tally) => {
      Object.entries(tally)
        .sort((a, b) => b[1].faced - a[1].faced)
        .slice(0, TOP_N)
        .forEach(([id]) => { if (!out.names[id]) idsNeeded.add(id); });
    });
    console.log(`Resolving ${idsNeeded.size} opponent name(s) for the top ${TOP_N} lists...`);
    for (const accId of idsNeeded) {
      out.names[accId] = (await resolvePlayerName(accId)) || null;
      await new Promise((r) => setTimeout(r, 500));
    }
    out.generatedAt = new Date().toISOString();
    fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
    console.log("Done.");
  })().catch((err) => { console.error(err); process.exit(1); });
}

main();
