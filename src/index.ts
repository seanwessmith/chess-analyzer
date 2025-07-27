import { mkdir } from "fs/promises";
import { resolve, dirname } from "path";
import { Database } from "bun:sqlite";
import fs from "node:fs";

const dbName = "games.sqlite";
const OUT_DIR = resolve(dirname(import.meta.dir), "pgn");
const DB_PATH = resolve(dirname(import.meta.dir), dbName);
const db = new Database(DB_PATH);

// ────────────────────────────────────────────────────────────
//  DB boot-strap
db.run(`
  CREATE TABLE IF NOT EXISTS games (
    id            INTEGER PRIMARY KEY,
    event         TEXT,
    site          TEXT,
    round         TEXT,
    game_date     TEXT,
    utc_time      TEXT,
    white_player  TEXT,
    black_player  TEXT,
    white_elo     INTEGER,
    black_elo     INTEGER,
    result        TEXT,
    eco_code      TEXT,
    time_control  TEXT,
    termination   TEXT,
    link          TEXT UNIQUE,        -- de-dupe on chess.com URL
    archive_link  TEXT,               -- removed UNIQUE - multiple games share same archive
    raw_pgn       TEXT
  );
`);

const checkLinkExists = db.prepare(
  `SELECT 1 FROM games WHERE archive_link = ?`
);

const insertGame = db.prepare(`
  INSERT OR IGNORE INTO games (
    event, site, round, game_date, utc_time,
    white_player, black_player, white_elo, black_elo,
    result, eco_code, time_control, termination, link, archive_link, raw_pgn
  ) VALUES (
    $event, $site, $round, $date, $time,
    $white, $black, $whiteElo, $blackElo,
    $result, $eco, $tc, $term, $link, $archiveLink, $raw
  );
`);

// ────────────────────────────────────────────────────────────
//  Simple PGN header parser
function splitGames(file: string): string[] {
  // Split before each [Event] tag
  const games = file
    .split(/\n(?=\[Event)/)
    .map((game) => game.trim())
    .filter((game) => game.length > 0);

  return games;
}

function parseHeaders(raw: string) {
  const tags: Record<string, string> = {};
  raw.split(/\r?\n/).forEach((ln) => {
    const m = ln.match(/^\[(\w+)\s+"([^"]*)"]/);
    if (m && m[1] && m[2]) tags[m[1]] = m[2];
  });
  return {
    event: tags.Event,
    site: tags.Site,
    round: tags.Round,
    date: tags.Date,
    time: tags.UTCTime,
    white: tags.White,
    black: tags.Black,
    whiteElo: Number(tags.WhiteElo) || null,
    blackElo: Number(tags.BlackElo) || null,
    result: tags.Result,
    eco: tags.ECO,
    tc: tags.TimeControl,
    term: tags.Termination,
    link: tags.Link,
  };
}

// ────────────────────────────────────────────────────────────
async function downloadAllGames(username: string) {
  await mkdir(OUT_DIR, { recursive: true });

  const archRes = await fetch(
    `https://api.chess.com/pub/player/${username}/games/archives`
  );
  if (!archRes.ok)
    throw new Error(`Failed to fetch archives ${archRes.status}`);

  const { archives } = (await archRes.json()) as { archives: string[] };

  for (const url of archives) {
    try {
      const urlExistsInDb = checkLinkExists.get(url);
      const [year, month] = url.split("/").slice(-2);
      const now = new Date();
      const nowYear = now.getFullYear().toString();
      const nowMonth = (now.getMonth() + 1).toString().padStart(2, "0");

      // Skip previous months if already downloaded. Always download current month for latest games.
      if (urlExistsInDb && !(year === nowYear && month === nowMonth)) {
        continue;
      }
      console.log(`Downloading ${url}`);

      const pgnRes = await fetch(`${url}/pgn`);
      if (!pgnRes.ok) throw new Error(`status ${pgnRes.status}`);

      const pgnText = await pgnRes.text();

      const games = splitGames(pgnText);
      console.log(games.length, "games found");

      const insertGames = db.transaction(() => {
        for (const gameRaw of games) {
          const h = parseHeaders(gameRaw);
          insertGame.run({
            $event: h.event || "",
            $site: h.site || "Chess.com",
            $round: h.round || "",
            $date: h.date || "",
            $time: h.time || null,
            $white: h.white || "",
            $black: h.black || "",
            $whiteElo: h.whiteElo || null,
            $blackElo: h.blackElo || null,
            $result: h.result || "",
            $eco: h.eco || "",
            $tc: h.tc || "",
            $term: h.term || "",
            $link: h.link || "",
            $archiveLink: url,
            $raw: gameRaw || "",
          });
        }
      });
      await insertGames();
    } catch (err) {
      console.error(`✗ Error:`, err);
    }
  }
}

// ────────────────────────────────────────────────────────────
async function main() {
  const username = process.argv[2];
  if (!username) {
    console.error("Usage: bun run src/download.ts <chess.com-username>");
    process.exit(1);
  }
  console.log(`Downloading games for ${username}…`);
  await downloadAllGames(username);
  console.log("Done.");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
