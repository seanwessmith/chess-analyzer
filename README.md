# Chess Analysis Project

A comprehensive chess game analysis tool that downloads games from Chess.com, stores them in a SQLite database, and performs deep analysis using Stockfish engine.

## Features

- 📥 **Game Downloader**: Automatically downloads all games from a Chess.com user
- 💾 **SQLite Storage**: Efficient local database storage for games and analysis
- 🔍 **Position Analysis**: Multi-threaded Stockfish analysis of every position
- 🎯 **Tactic Detection**: Identifies specific tactical patterns (e.g., knight forks)
- 📊 **Statistical Analysis**: Generate reports on openings, errors, and patterns

## Prerequisites

- [Bun](https://bun.sh/) runtime
- [Stockfish](https://stockfishchess.org/download/) chess engine installed and accessible in PATH
- Node.js packages:
  - `chess.js` - Chess move generation/validation
  - `@mliebelt/pgn-parser` - PGN parsing
  - `inquirer` - CLI interactions
  - `bun:sqlite` - SQLite database

## Installation

```bash
# Clone the repository
git clone <repository-url>
cd chess-analysis

# Install dependencies
bun install
```

## Project Structure

```
.
├── index.ts             # Main game downloader
├── get-data.ts          # Stockfish position analysis
├── analyze.ts           # Tactical pattern detection
├── stockfish-tools/     # Stockfish engine pool management
│   └── index.ts
├── pgn/                 # Downloaded PGN files by month
│   ├── 2020-06.pgn
│   ├── 2020-07.pgn
│   └── ...
└── games.sqlite         # SQLite database
```

## Usage

### 1. Download Games from Chess.com

```bash
bun run index.ts <chess.com-username>
```

This will:
- Fetch all games for the specified user
- Store them in `games.sqlite` database

### 2. Analyze Positions with Stockfish

```bash
bun run get-data.ts
```

This will:
- Load games from the database
- Analyze each position using Stockfish
- Store top 5 engine moves for each position
- Use multi-threaded analysis for performance

### 3. Detect Tactical Patterns

```bash
bun run analyze.ts <your-username> <pgn-file>
```

Interactive CLI to detect specific tactics like:
- Knight forks on King + Queen
- (More tactics can be added)

## Database Schema

### `games` table
- `id`: Primary key
- `event`, `site`, `round`: Tournament information
- `game_date`, `utc_time`: Temporal data
- `white_player`, `black_player`: Player names
- `white_elo`, `black_elo`: Player ratings
- `result`: Game outcome
- `eco_code`: Opening classification
- `time_control`, `termination`: Game metadata
- `link`: Chess.com game URL
- `archive_link`: Archive API URL
- `raw_pgn`: Complete PGN text

### `moves` table
- `id`: Primary key
- `game_id`: Foreign key to games
- `ply`: Move number (1-based)
- `san`: Move in Standard Algebraic Notation
- `fen`: Position after the move
- `clock_ms`: Time remaining (if available)

### `best_moves` table
- `id`: Primary key
- `move_id`: Foreign key to moves
- `rank`: 1-5 (best to 5th best)
- `san_line`: Suggested move
- `eval_cp`: Centipawn evaluation

## Configuration

### Stockfish Settings (in `stockfish-tools/index.ts`)

```typescript
createEnginePool({
  poolSize: 4,        // Number of Stockfish instances
  threadsPer: 2,      // Threads per instance
  hashMb: 2048,       // Hash table size
  multipv: 5          // Number of variations to analyze
})
```

### Analysis Settings

- `moveTime`: Time per position (default: 1000ms)
- Adjust based on desired depth vs speed

## Python Analysis Scripts

The `python/` directory contains additional analysis tools:
- `analyze.py`: Statistical analysis of games
- `error_summary.csv`: Blunder/mistake detection results
- `opening_summary.csv`: Opening repertoire analysis

## Examples

### Count Knight Forks by Month

```typescript
const results = countTacticOccurrences(
  pgns,
  "YourUsername",
  detectKnightKingQueenFork
);
console.table(results.counts);
```

### Analyze Single Game

```typescript
const analyses = await analyzePgnPositions(pgnString);
// Returns position-by-position analysis with best moves
```

## Performance Considerations

- Uses connection pooling for Stockfish engines
- Batch processing with transactions for database operations
- Skips already analyzed games to allow incremental updates
- Multi-threaded analysis scales with CPU cores

## Troubleshooting

1. **Stockfish not found**: Ensure Stockfish is installed and in PATH
2. **Memory issues**: Reduce `hashMb` or `poolSize` settings
3. **Slow analysis**: Adjust `moveTime` or reduce `multipv`
4. **Database locked**: Ensure only one process accesses the database

## Future Enhancements

- [ ] Add more tactical pattern detectors
- [ ] Web interface for visualization
- [ ] Opening book integration
- [ ] Blunder detection and classification
- [ ] ELO progression tracking
- [ ] Opponent analysis features

## AWS Execution Model
Below is a field-tested pattern my team has used to chew through millions of games in hours instead of days.  Feel free to lift as much (or as little) as you like.

⸻

1  Overall execution model

Stage	What happens	AWS service that fits best
Shard	Split the monolithic PGN dump into 1 000-to-5 000-game “shards” and drop each shard in S3 (e.g. pgn/shard-00042.pgn).	A one-off bun run split-pgns.ts on your laptop or a tiny Lambda
Queue	Publish one SQS message per shard containing the S3 key.	Amazon SQS (standard queue)
Worker	Container starts → pulls a message → streams the shard from S3 → runs get-data.ts → analyzePgnPositionsBatch → writes results (json/parquet/sqlite) to s3://…/results/ → deletes the message.	AWS Batch or ECS Fargate (Batch is simpler if you want auto-scaled Spot instances)
Post-process	Merge the per-shard result files into Aurora Postgres or query them directly with Athena/Glue.	Athena / Glue / a single merge script

The queue completely decouples you from the number of instances—add 5 or 500 and the backlog just drains faster.

⸻

2  Result & runtime expectations

Example fleet	Concurrency	Moves-per-second*	100 k games (≈8 M moves)
10 × r7iz.xlarge	40 vCPU	~5 400	≈ 25 min
20 × c6i.4xlarge Spot	320 vCPU	~32 000	≈ 4 min (throughput king)

*Assumes Stockfish 16, -threads 2, movetime 200 ms, AVX2 build.

⸻

3  Little optimisations that pay big dividends
	•	Build Stockfish for the target ISA
make build ARCH=x86-64-avx2 (z1d) ARCH=x86-64-sapphirerapids (r7iz) ARCH=armv8-neon (Graviton).
	•	Lower moveTime when you only need a tactical evaluation; 200 ms is often indistinguishable from 1 000 ms for fork detection.
	•	Write results once: emit JSON/Parquet per shard and query with Athena; merging SQLite files over NFS will bottleneck.

⸻

TL;DR
	1.	Shard → Queue → Batch is the simplest, fully managed pattern.
	2.	r7iz wins on raw per-core speed; z1d is a close second and cheaper; c6i/c7i win on $ / throughput.
	3.	Containerise once, let AWS Batch spray shards across Spot instances, and you can process an entire year of Chess-com games in the time it takes to drink a coffee.
