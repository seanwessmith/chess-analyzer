import { Chess } from "chess.js";
import { createEnginePool } from "./stockfish-tools/index";
import { resolve, dirname } from "path";
import { Database } from "bun:sqlite";

/** A single move returned by Stockfish for a given position. */
export interface TacticalMove {
  san: string;
  evaluation: string;
}

/** The analysed data we collect for every ply. */
export interface PositionAnalysis {
  /** 1‑based ply index (half‑move number). */
  ply: number;
  /** SAN representation of the move that produced this position. */
  moveSAN: string;
  /** FEN string *after* the move. */
  fen: string;
  /** Stockfish top‑5 moves for this position. */
  bestMoves: TacticalMove[];
}

const DB_PATH = resolve(dirname(import.meta.dir), "games.sqlite");
const db = new Database(DB_PATH);

/* ─────────────────────────────────────────────────────────
   1) Ensure move-level tables exist
   (schema matches the earlier design)                       */
db.run(`
  CREATE TABLE IF NOT EXISTS moves (
    id          INTEGER PRIMARY KEY,
    game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    ply         INTEGER NOT NULL,
    san         TEXT    NOT NULL,
    fen         TEXT    NOT NULL,
    clock_ms    INTEGER,
    UNIQUE(game_id, ply)
  );

  CREATE TABLE IF NOT EXISTS best_moves (
    id          INTEGER PRIMARY KEY,
    move_id     INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
    rank        INTEGER NOT NULL,
    san_line    TEXT    NOT NULL,
    eval_cp     REAL,
    UNIQUE(move_id, rank)
  );
`);

/* Prepared statements for speed */
const hasMoves = db.prepare("SELECT 1 FROM moves WHERE game_id = ? LIMIT 1");
const insertMove = db.prepare(`
  INSERT OR IGNORE INTO moves (game_id, ply, san, fen) VALUES (?, ?, ?, ?)
`);
const insertMoves = db.prepare(`
  INSERT OR REPLACE INTO best_moves (move_id, rank, san_line, eval_cp)
  VALUES (?, ?, ?, ?)
`);
const getMoveId = db.prepare(
  "SELECT id FROM moves WHERE game_id = ? AND ply = ?"
);

const pool = createEnginePool({
  poolSize: 4, // 4 engines for balance
  threadsPer: 2, // 2 threads each = 8 cores used
  hashMb: 1024, // Reduced for better concurrency
  multipv: 5,
});

/**
 * Optimized version that analyzes multiple positions in parallel
 */
export async function analyzePgnPositionsBatch(pgn: string, gameId: number) {
  const chess = new Chess();
  chess.loadPgn(pgn);
  const allMoves = chess.history();

  // Get the starting FEN from the loaded game
  const headers = chess.getHeaders();
  // startingFen can be differnt due to handicaps or custom setups
  const startingFen =
    headers.SetUp === "1" && headers.FEN ? headers.FEN : undefined;

  // Reset to the correct starting position
  if (startingFen) {
    chess.load(startingFen);
  } else {
    chess.reset();
  }

  // Prepare all positions first
  const positions: { ply: number; moveSAN: string; fen: string }[] = [];

  for (let i = 0; i < allMoves.length; i++) {
    const move = allMoves[i]!;
    chess.move(move);

    positions.push({
      ply: i + 1,
      moveSAN: move,
      fen: chess.fen(),
    });
  }

  const analysisPromises = positions.map((pos) =>
    pool.analyze(pos.fen).then((bestMoves) => ({
      ...pos,
      bestMoves:
        bestMoves?.map((line) => ({
          san: line.san,
          evaluation: line.evaluation,
        })) ?? [],
    }))
  );

  return Promise.all(analysisPromises);
}

/**
 * Process multiple games concurrently
 */
async function mainOptimized() {
  const CONCURRENT_GAMES = 4; // Process 4 games at once
  const BATCH_SIZE = 100; // Process games in batches

  const games = db.query("SELECT id, raw_pgn FROM games").all() as {
    id: number;
    raw_pgn: string;
  }[];

  console.log(`Found ${games.length} games in DB…`);

  // Filter out already processed games
  // ignore games with "Variant" in raw_pgn
  const unprocessedGames = games.filter(
    (g) => !hasMoves.get(g.id) && !g.raw_pgn.includes("Variant")
  );
  console.log(`${unprocessedGames.length} games need analysis`);

  // Calculate time estimate
  const avgMovesPerGame = 80;
  const totalMoves = unprocessedGames.length * avgMovesPerGame;
  const moveTimeSeconds = 1;
  const effectiveParallelism = CONCURRENT_GAMES * 4; // 4 games × 4 engines
  const estimatedHours =
    (totalMoves * moveTimeSeconds) / (effectiveParallelism * 3600);

  console.log(
    `Estimated time: ${estimatedHours.toFixed(1)} hours with ${effectiveParallelism}x parallelism`
  );

  // Process in batches
  for (let i = 0; i < unprocessedGames.length; i += BATCH_SIZE) {
    const batch = unprocessedGames.slice(i, i + BATCH_SIZE);
    console.log(
      `Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(unprocessedGames.length / BATCH_SIZE)}`
    );

    // Process CONCURRENT_GAMES at a time within each batch
    for (let j = 0; j < batch.length; j += CONCURRENT_GAMES) {
      const gameBatch = batch.slice(j, j + CONCURRENT_GAMES);

      const analysisPromises = gameBatch.map(
        async ({ id: gameId, raw_pgn }) => {
          try {
            const startTime = Date.now();
            const plys = await analyzePgnPositionsBatch(raw_pgn, gameId);
            const duration = (Date.now() - startTime) / 1000;

            // Store results
            await db.transaction(() => {
              for (const ply of plys) {
                insertMove.run(gameId, ply.ply, ply.moveSAN, ply.fen);
                const row = getMoveId.get(gameId, ply.ply) as
                  | { id: number }
                  | undefined;
                if (!row) continue;

                const moveId = row.id;
                ply.bestMoves.forEach((move, idx) => {
                  insertMoves.run(
                    moveId,
                    idx + 1,
                    move.san,
                    parseFloat(move.evaluation)
                  );
                });
              }
            })();

            console.log(
              `✓ Game ${gameId}: ${plys.length} moves in ${duration.toFixed(1)}s`
            );
            return { gameId, success: true, moves: plys.length, duration };
          } catch (e) {
            console.error(`✗ Game ${gameId} failed:`, e);
            return { gameId, success: false, error: e };
          }
        }
      );

      const results = await Promise.all(analysisPromises);

      // Log batch statistics
      const successful = results.filter((r) => r.success) as {
        gameId: number;
        success: boolean;
        moves: number;
        duration: number;
        error: undefined;
      }[];
      const totalMoves = successful.reduce((sum, r) => sum + r.moves, 0);
      const avgDuration =
        successful.reduce((sum, r) => sum + r.duration, 0) / successful.length;

      console.log(
        `Batch complete: ${successful.length}/${gameBatch.length} games, ${totalMoves} moves, avg ${avgDuration.toFixed(1)}s/game`
      );
    }
  }

  console.log("Analysis complete!");
  pool.terminate();
}

// Run the optimized version
if (import.meta.main) {
  mainOptimized().catch((e) => {
    console.error("Fatal error:", e);
    pool.terminate();
    process.exit(1);
  });
}
