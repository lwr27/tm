// Builds the author-medal table across all TOTD maps.
//
// Run with: npm run authors
// Requires .env with NADEO_SERVER_LOGIN / NADEO_SERVER_PASSWORD.
//
// ARCHITECTURE (v3): trackmania.io is only used for the TOTD map listing
// (~73 requests total). Everything per-map goes through Nadeo's
// authenticated API instead, which has a separate (and gentler) rate
// budget than trackmania.io's public one that we kept exhausting:
//
//   - Author count: ONE request via the "surround" endpoint — ask it what
//     position the author time would sit at on the leaderboard, and the
//     answer *is* the count of players at-or-better. No searching at all.
//   - Total finishers: same trick with an absurdly slow time — its
//     position is the total number of finishers.
//   - Personal medals: the mapRecords endpoint (already proven working),
//     one request covers all three players.
//
// That's 3 Nadeo requests per map, ~2.5s per map, full TOTD history in
// roughly 1.5-2 hours — resumable at any point, as before.

const fs = require("fs");
const path = require("path");
const { nadeoFetch } = require("./nadeo-auth");

const LIVE = "NadeoLiveServices";
const CORE = "NadeoServices";
const USER_AGENT = process.env.TM_USER_AGENT || "tm-cotd-tracker author-medals / contact: lewis (github.com/lwr27/lab)";
const OUT_PATH = path.join(__dirname, "authors.json");

const MONTHS_TO_FETCH = 200; // loop stops automatically at the edge of TOTD history

// XV27 only for this table, per instruction — not merged with Whidot.
const PLAYERS = [
  { name: "XV27", accountId: "8b537233-4931-49a8-af54-b0cefc33fa72" },
  { name: "TheBreaker0", accountId: "07859bb1-b0bd-4748-b1bb-4ecb173786c6" },
  { name: "Pho3nix_.", accountId: "ede8dd52-dc02-4abc-a864-eb6e3934bc2b" },
];

// Appends an entry to the shared medal-achievement log (results.medalEvents),
// deduped so the same player+map is never logged twice. Prefers the
// record's own timestamp (when Nadeo actually set the time); falls back to
// "detected today" if that field turns out to be missing.
function logMedalEvent(results, playerName, entry, recordTimestamp){
  results.medalEvents = results.medalEvents || [];
  const key = `${playerName}|${entry.mapUid}`;
  if (results.medalEvents.some((e) => e.key === key)) return;
  results.medalEvents.push({
    key,
    player: playerName,
    mapUid: entry.mapUid,
    mapName: entry.name,
    achievedAt: recordTimestamp || null,
    detectedAt: new Date().toISOString(),
  });
}

// --- TOTD listing (trackmania.io, cheap, once per run) ---

// Watchdog: prints a heartbeat every 30s with the current operation, so a
// silent freeze can be told apart from slow-but-working. If heartbeats
// stop appearing, the process itself is dead; if they keep coming, it's
// alive and just waiting on rate limits.
let currentOp = "starting up";
function setOp(label){ currentOp = label; }
setInterval(() => { console.log(`  [heartbeat] still running — ${currentOp}`); }, 30000).unref();

async function tmioFetch(url, maxRetries = 5) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res, body;
    setOp(`fetching ${url.slice(0, 90)} (attempt ${attempt + 1})`);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: controller.signal });
        if (res.ok) {
          // Read the body while the timeout is still armed — a stalled
          // body download was exactly where earlier runs froze forever.
          setOp(`downloading response body for ${url.slice(0, 90)}`);
          body = await res.json();
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      console.warn(`  request hung/failed (${err.name === "AbortError" ? "timed out after 20s" : err.message}), retrying (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = retryAfter ? retryAfter * 1000 : Math.min(30000, 2000 * 2 ** attempt);
      console.warn(`  rate limited (429) on trackmania.io, waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${maxRetries})`);
      setOp(`waiting out a ${Math.round(waitMs / 1000)}s rate limit`);
      await new Promise((r) => setTimeout(r, waitMs));
      console.log(`  wait over, retrying now...`);
      continue;
    }
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return body;
  }
  throw new Error(`${url} -> failed after ${maxRetries} retries`);
}

async function getTotdMonth(index) {
  const data = await tmioFetch(`https://trackmania.io/api/totd/${index}`);
  const days = data.days || [];
  if (index === 0 && days.length) {
    const d = days[0];
    console.log("Day-entry fields (excluding 'map'):", JSON.stringify(Object.fromEntries(Object.entries(d).filter(([k]) => k !== "map"))));
  }
  return days
    .map((d) => {
      const map = d.map || d;
      if (!map || !map.mapUid) return null;
      return {
        mapUid: map.mapUid,
        mapId: map.mapId,
        name: map.name,
        authorTimeMs: map.authorScore,
        day: d.monthday ?? d.monthDay ?? d.day ?? null,
        monthYear: data.year && data.month ? `${data.year}-${String(data.month).padStart(2, "0")}` : null,
        leaderboardUid: d.leaderboarduid || null,
      };
    })
    .filter(Boolean);
}

// --- Per-map data (Nadeo, authenticated, separate rate budget) ---

let surroundLogCount = 0;
let emptyLogCount = 0;

// The surround endpoint returns the leaderboard entry at the position a
// given score would occupy. That position IS the count of players at or
// better than that score — one request, no searching.
async function positionOfScore(mapUid, score, groupUid) {
  const group = groupUid || "Personal_Best";
  const data = await nadeoFetch(
    `https://live-services.trackmania.nadeo.live/api/token/leaderboard/group/${group}/map/${mapUid}/surround/0/0?score=${score}&onlyWorld=true`,
    LIVE
  );
  if (surroundLogCount < 3) {
    surroundLogCount++;
    console.log(`  Raw surround response for ${mapUid} (group ${group}) at score=${score}:`);
    console.log("  " + JSON.stringify(data).slice(0, 400));
  }
  const top = data.tops && data.tops[0] && data.tops[0].top;
  if (!top || !top.length) {
    if (emptyLogCount < 3) {
      emptyLogCount++;
      console.log(`  (empty surround response for ${mapUid} in group ${group})`);
    }
    return null; // caller decides how to handle — do NOT treat as a real 0
  }
  return { position: top[0].position, entryScore: top[0].score };
}

// --- trackmania.io fallback (batch search) for maps where Nadeo's
// surround endpoint returns empty (seems to happen on older TOTDs) ---
const BATCH_SIZE = 100;
async function tmioLeaderboardBatch(mapUid, offset) {
  const data = await tmioFetch(`https://trackmania.io/api/leaderboard/map/${mapUid}?offset=${offset}&length=${BATCH_SIZE}`);
  return { rows: data.tops || [], playercount: data.playercount ?? null };
}
function batchFullyUnder(batch, t) {
  return batch.rows.length === BATCH_SIZE && batch.rows[batch.rows.length - 1].time <= t;
}
async function tmioCountAuthorAndTotal(mapUid, authorTimeMs) {
  const cache = {};
  async function batchAt(idx) {
    if (cache[idx]) return cache[idx];
    const b = await tmioLeaderboardBatch(mapUid, idx * BATCH_SIZE);
    cache[idx] = b;
    await new Promise((r) => setTimeout(r, 2000));
    return b;
  }
  const lastPos = (b) => {
    for (let i = b.rows.length - 1; i >= 0; i--) if (b.rows[i].position != null) return b.rows[i].position;
    return null;
  };

  const first = await batchAt(0);
  if (!first.rows.length) {
    return { authorCount: 0, totalFinishers: Math.max(0, first.playercount ?? 0) };
  }

  // trackmania.io only serves the top 10,000 leaderboard positions. The
  // clamped far page tells us the end of the VISIBLE board; the real
  // total can exceed it, in which case playercount is the only source.
  const far = await tmioLeaderboardBatch(mapUid, 5000000);
  await new Promise((r) => setTimeout(r, 2000));
  const visibleEnd = lastPos(far);
  const pc = (first.playercount && first.playercount > 0) ? first.playercount : null;
  let totalFinishers;
  if (visibleEnd != null && pc != null) totalFinishers = Math.max(visibleEnd, pc);
  else if (visibleEnd != null) totalFinishers = (visibleEnd >= 10000) ? null : visibleEnd; // full board hidden behind the cap and no usable playercount
  else totalFinishers = pc;

  if (first.rows[0].time > authorTimeMs) {
    return { authorCount: 0, totalFinishers: totalFinishers ?? 0 };
  }
  // If even the last VISIBLE player is under author time, the true author
  // count lies beyond the cap — report it as ">= visibleEnd" rather than
  // inventing a number.
  if (far.rows.length && far.rows[far.rows.length - 1].time <= authorTimeMs) {
    const capped = totalFinishers == null || (visibleEnd != null && totalFinishers > visibleEnd);
    if (capped) {
      return { authorCount: visibleEnd ?? far.rows.length, totalFinishers, authorCapped: true };
    }
    return { authorCount: totalFinishers, totalFinishers };
  }

  const searchLimit = visibleEnd ?? totalFinishers ?? 10000;
  const maxBatch = Math.max(0, Math.ceil(searchLimit / BATCH_SIZE) - 1);

  let lo = 0, hi = 0;
  if (batchFullyUnder(first, authorTimeMs)) {
    hi = 1;
    while (hi < maxBatch) {
      const b = await batchAt(hi);
      if (!batchFullyUnder(b, authorTimeMs)) break;
      lo = hi;
      hi = Math.min(hi * 2, maxBatch);
      if (lo === hi) break;
    }
    const bHi = await batchAt(hi);
    if (batchFullyUnder(bHi, authorTimeMs)) {
      // last searchable page still fully under — trust the far-page check
      // above over this; report up to that page's end
      const p = lastPos(bHi);
      const t = totalFinishers ?? (p ?? (hi + 1) * BATCH_SIZE);
      return { authorCount: p ?? (hi + 1) * BATCH_SIZE, totalFinishers: t };
    }
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      const b = await batchAt(mid);
      if (batchFullyUnder(b, authorTimeMs)) lo = mid; else hi = mid - 1;
    }
    hi = lo + 1 <= maxBatch ? lo + 1 : lo;
  }

  // Crossover is inside batch `hi`. Prefer the crossover row's own
  // position (immune to offset clamping); offset math is the fallback.
  const crossoverCheck = await batchAt(hi);
  const cross = crossoverCheck.rows.find((r) => r.time > authorTimeMs);
  let authorCount;
  if (cross && cross.position != null) {
    authorCount = cross.position - 1;
  } else {
    const idx2 = crossoverCheck.rows.findIndex((r) => r.time > authorTimeMs);
    const countInBatch2 = idx2 === -1 ? crossoverCheck.rows.length : idx2;
    authorCount = hi * BATCH_SIZE + countInBatch2;
  }
  if (totalFinishers != null) authorCount = Math.min(authorCount, totalFinishers);
  return { authorCount: Math.max(0, authorCount), totalFinishers: totalFinishers ?? 0 };
}

async function countAuthorAndTotal(entry) {
  const { mapUid, authorTimeMs, leaderboardUid } = entry;

  // Try the global Personal_Best group first (works for recent maps),
  // then the map's own TOTD leaderboard group (older maps drop out of
  // Personal_Best but keep this one), then trackmania.io as last resort.
  let group = null;
  let authorProbe = await positionOfScore(mapUid, authorTimeMs, null);
  await new Promise((r) => setTimeout(r, 700));

  if (authorProbe == null && leaderboardUid) {
    group = leaderboardUid;
    authorProbe = await positionOfScore(mapUid, authorTimeMs, group);
    await new Promise((r) => setTimeout(r, 700));
    if (authorProbe != null) console.log("  (found via map-specific leaderboard group)");
  }

  if (authorProbe == null) {
    console.log("  Nadeo surround empty in both groups — falling back to trackmania.io for this map");
    return tmioCountAuthorAndTotal(mapUid, authorTimeMs);
  }

  const endProbe = await positionOfScore(mapUid, 999999999, group);
  await new Promise((r) => setTimeout(r, 700));

  let authorCount = 0;
  if (authorProbe.position > 0) {
    authorCount = authorProbe.entryScore != null && authorProbe.entryScore <= authorTimeMs
      ? authorProbe.position
      : authorProbe.position - 1;
  }
  const totalFinishers = endProbe ? endProbe.position : 0;
  // "Every single finisher has the author medal" on a big board is almost
  // certainly the surround endpoint misbehaving, not reality — verify the
  // suspicious ones through the independent trackmania.io path instead.
  if (totalFinishers > 200 && authorCount >= totalFinishers) {
    console.log("  surround result looks implausible (100% authors) — double-checking via trackmania.io");
    return tmioCountAuthorAndTotal(mapUid, authorTimeMs);
  }
  return { authorCount: Math.max(0, authorCount), totalFinishers };
}

let loggedRecordShape = false;
async function getPlayerScores(mapId, accountIds) {
  const idList = accountIds.join(",");
  const data = await nadeoFetch(
    `https://prod.trackmania.core.nadeo.online/v2/mapRecords/?accountIdList=${idList}&mapId=${mapId}`,
    CORE
  );
  if (!loggedRecordShape && Array.isArray(data) && data.length) {
    loggedRecordShape = true;
    console.log("  Raw mapRecords entry (checking for a timestamp field):");
    console.log("  " + JSON.stringify(data[0]));
  }
  const byAccount = {};
  (Array.isArray(data) ? data : []).forEach((rec) => {
    if (rec.recordScore && rec.recordScore.time != null) {
      byAccount[rec.accountId] = { time: rec.recordScore.time, timestamp: rec.timestamp || null };
    }
  });
  return byAccount;
}

// --- Main ---

async function main() {
  const MONTHS_CACHE = path.join(__dirname, "totd-months.json");
  let allMaps = null;

  // Incremental listing: if we have a cached listing (any age), just fetch
  // the CURRENT month (index 0, plus index 1 in the first days of a month
  // to be safe) and merge the new days in — 1-2 requests instead of ~73.
  // A full history crawl only happens when no cache exists at all.
  if (fs.existsSync(MONTHS_CACHE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(MONTHS_CACHE, "utf8"));
      if (Array.isArray(cached.maps) && cached.maps.length) {
        allMaps = cached.maps;
        console.log(`Using cached TOTD listing (${allMaps.length} maps) — fetching just the current month for new days...`);
        const indices = new Date().getDate() <= 3 ? [0, 1] : [0];
        const fresh = [];
        for (const i of indices) {
          try { fresh.push(...await getTotdMonth(i)); }
          catch (err) { console.warn(`  month index ${i} refresh failed (${err.message}) — continuing with cached listing`); }
          await new Promise((r) => setTimeout(r, 700));
        }
        if (fresh.length) {
          const freshUids = new Set(fresh.map((m) => m.mapUid));
          allMaps = fresh.concat(allMaps.filter((m) => !freshUids.has(m.mapUid)));
          fs.writeFileSync(MONTHS_CACHE, JSON.stringify({ fetchedAt: new Date().toISOString(), maps: allMaps }, null, 2));
          console.log(`  merged ${fresh.length} current-month day(s); listing now ${allMaps.length} maps.`);
        }
      }
    } catch (e) { allMaps = null; /* fall through to full crawl */ }
  }

  if (!allMaps) {
    console.log(`Fetching full TOTD month listing from trackmania.io (first run only)...`);
    allMaps = [];
    for (let i = 0; i < MONTHS_TO_FETCH; i++) {
      try {
        const days = await getTotdMonth(i);
        if (!days.length) { console.log(`Month index ${i}: empty — reached the start of TOTD history, stopping.`); break; }
        console.log(`Month index ${i}: ${days.length} maps`);
        allMaps = allMaps.concat(days);
      } catch (err) {
        console.log(`Month index ${i} failed (${err.message}) — treating as the edge of TOTD history and stopping.`);
        break;
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    fs.writeFileSync(MONTHS_CACHE, JSON.stringify({ fetchedAt: new Date().toISOString(), maps: allMaps }, null, 2));
  }

  console.log(`\n${allMaps.length} TOTD maps total.`);
  if (!allMaps.length) return;

  const results = fs.existsSync(OUT_PATH) ? JSON.parse(fs.readFileSync(OUT_PATH, "utf8")) : { maps: [] };
  results.maps = results.maps || [];
  const isStale = (m) => m.authorTimeMs != null && (
    m.authorCount == null
    || m.totalFinishers == null
    || m.totalFinishers < 0
    || (m.authorCount === 0 && m.totalFinishers === 0)
    || m.authorCount > m.totalFinishers
    // unverified 100%-author rows on big boards came from earlier buggy
    // runs; entries written by the current code carry verified:true
    || (!m.verified && m.totalFinishers > 200 && m.authorCount === m.totalFinishers)
    // the 10000/10000 fingerprint = the previous run hitting tmio's 10k
    // leaderboard cap and mistaking it for "everyone has author"
    || (m.authorCount === 10000 && m.totalFinishers === 10000 && !m.authorCapped)
  );
  const doneUids = new Set(results.maps.filter((m) => !isStale(m)).map((m) => m.mapUid));
  results.maps = results.maps.filter((m) => !isStale(m));

  // Backfill date/name fields on already-cached entries — earlier versions
  // of this script didn't parse the day correctly, and the resume logic
  // would otherwise leave those entries stuck with day:null forever.
  const byUid = {};
  allMaps.forEach((e) => { byUid[e.mapUid] = e; });
  let patched = 0;
  results.maps.forEach((m) => {
    const fresh = byUid[m.mapUid];
    if (!fresh) return;
    if (m.day == null && fresh.day != null) { m.day = fresh.day; patched++; }
    if (!m.monthYear && fresh.monthYear) m.monthYear = fresh.monthYear;
    if (!m.mapId && fresh.mapId) m.mapId = fresh.mapId;
    if (!m.leaderboardUid && fresh.leaderboardUid) m.leaderboardUid = fresh.leaderboardUid;
  });
  if (patched) {
    console.log(`Backfilled day/date info on ${patched} already-cached map(s).`);
    fs.writeFileSync(OUT_PATH, JSON.stringify(results, null, 2));
  }

  let processed = 0;
  const todo = allMaps.filter((e) => !doneUids.has(e.mapUid));
  console.log(`${todo.length} maps still to fetch (${allMaps.length - todo.length} already cached).\n`);

  for (const entry of todo) {
    processed++;
    console.log(`[${processed}/${todo.length}] ${entry.name || entry.mapUid} (${entry.monthYear || "?"}${entry.day ? " day " + entry.day : ""})...`);

    if (entry.authorTimeMs == null) {
      console.warn("  no author time in TOTD listing — skipping");
      results.maps.push({ ...entry, authorCount: null, totalFinishers: null, pct: null, playerHasAuthor: {} });
      fs.writeFileSync(OUT_PATH, JSON.stringify(results, null, 2));
      continue;
    }

    try {
      const { authorCount, totalFinishers, authorCapped } = await countAuthorAndTotal(entry);
      await new Promise((r) => setTimeout(r, 700));

      let playerHasAuthor = {};
      if (entry.mapId) {
        try {
          const scores = await getPlayerScores(entry.mapId, PLAYERS.map((p) => p.accountId));
          PLAYERS.forEach((p) => {
            const rec = scores[p.accountId];
            const has = rec != null && rec.time <= entry.authorTimeMs;
            playerHasAuthor[p.name] = has;
            if (has) logMedalEvent(results, p.name, entry, rec.timestamp);
          });
        } catch (err) {
          console.warn(`  personal medal check failed (${err.message}) — leaving blank`);
        }
      }

      const pct = totalFinishers ? Math.round((authorCount / totalFinishers) * 1000) / 10 : null;
      console.log(`  ${authorCapped ? '>=' : ''}${authorCount}/${totalFinishers ?? '?'} have author (${pct != null ? pct + '%' : '?'}). Ours: ${JSON.stringify(playerHasAuthor)}`);
      results.maps.push({ ...entry, authorCount, totalFinishers, pct, playerHasAuthor, authorCapped: !!authorCapped, verified: true });
    } catch (err) {
      console.error(`  failed: ${err.message}`);
    }
    results.generatedAt = new Date().toISOString();
    fs.writeFileSync(OUT_PATH, JSON.stringify(results, null, 2));
    await new Promise((r) => setTimeout(r, 700));
  }

  console.log(`\nDone. Wrote ${OUT_PATH}.`);
}

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION (this would previously have silently killed the process):", err && err.message);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err && err.message);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
