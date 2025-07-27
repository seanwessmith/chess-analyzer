import os from "node:os";
import { Chess } from "chess.js";
import { sleep, spawn } from "bun";

// -------------------------------------------------------------
// Types
// -------------------------------------------------------------
export interface EngineResult {
  ply: number; // 1-based ply index
  fen: string;
  info: StockfishLine[];
}

export interface StockfishLine {
  san: string; // first move of the PV in SAN
  evaluation: string; // "+0.23" or "#-5" (mate-in-5)
  raw: string; // full info line (for debugging)
}

// -------------------------------------------------------------
// Engine – wraps one Stockfish process
// -------------------------------------------------------------
class Engine {
  private proc = spawn(["stockfish"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  private busy = false;
  private q: {
    fen: string;
    resolve: (v: StockfishLine[]) => void;
    reject: (e: Error) => void;
  }[] = [];
  private readonly decoder = new TextDecoder();
  private currentResolve?: (v: StockfishLine[]) => void;
  private currentReject?: (e: Error) => void;
  private currentLines: ParsedInfoLine[] = [];
  private currentFen?: string;
  private initialized = false;
  private initResolve?: () => void;
  private initReject?: (e: Error) => void;
  private terminated = false;
  private multipv: number;
  public readonly ready: Promise<void>;

  constructor(threads: number, hashMb: number, multipv: number) {
    // Start background stderr reader
    this.readStderr(this.proc.stderr).catch(console.error);

    this.multipv = multipv;
    this.ready = this.init(threads, hashMb, multipv);
  }

  private async init(t: number, h: number, m: number) {
    // Set up a persistent reader for stdout
    this.readOutputStream();

    // Small delay to ensure reader is ready
    await sleep(100);

    const initCmds = [
      "uci",
      `setoption name Threads value ${t}`,
      `setoption name Hash value ${h}`,
      `setoption name MultiPV value ${m}`,
    ];
    for (const c of initCmds) this.proc.stdin.write(c + "\n");

    // Wait for "uciok" with timeout
    await new Promise<void>((resolve, reject) => {
      this.initResolve = resolve;
      this.initReject = reject;
      setTimeout(() => reject(new Error("Stockfish init timeout")), 5000);
    });

    this.initialized = true;
    this.processNext();
  }

  private async readOutputStream() {
    try {
      for await (const chunk of this.proc.stdout) {
        if (this.terminated) break;
        const txt = this.decoder.decode(chunk);
        for (const l of txt.split(/\r?\n/)) {
          if (!l.trim()) continue;

          // Handle initialization
          if (!this.initialized) {
            if (l.includes("uciok")) {
              this.initResolve?.();
            }
            continue;
          }

          // Handle analysis output
          if (this.currentResolve) {
            if (l.startsWith("info")) {
              const parsed = parseStockfishInfo(l);
              if (parsed) this.currentLines[parsed.multipv - 1] = parsed;
            }
            if (l.startsWith("bestmove")) {
              const filteredLines = this.currentLines.filter(Boolean);
              const info: StockfishLine[] = filteredLines.map((p) => ({
                san: this.currentFen ? uciToSAN(p.uci, this.currentFen) : p.uci,
                evaluation: p.evaluation,
                raw: p.raw,
              }));
              // Pad with empty lines if fewer than MultiPV
              while (info.length < this.multipv)
                info.push({ san: "", evaluation: "", raw: "" });
              this.currentResolve(info);
              this.cleanupCurrent();
              this.processNext();
            }
          }
        }
      }
    } catch (e) {
      if (!this.terminated) this.currentReject?.(e as Error);
    }
  }

  private async readStderr(stream: ReadableStream<Uint8Array>) {
    try {
      for await (const chunk of stream) {
        const txt = this.decoder.decode(chunk).trim();
        if (txt) console.error(`Stockfish stderr: ${txt}`);
      }
    } catch (e) {
      console.error("Stderr read error:", e);
    }
  }

  terminate() {
    this.terminated = true;
    this.proc.stdin.write("quit\n");
    this.proc.kill();
    this.q.forEach((job) => job.reject(new Error("Engine terminated")));
    this.q = [];
  }

  moveTime = 1000; // default movetime in ms

  /** Enqueue a FEN for analysis. */
  async analyze(fen: string): Promise<StockfishLine[]> {
    await this.ready; // Ensure initialized before queuing
    return new Promise((resolve, reject) => {
      this.q.push({ fen, resolve, reject });
      if (!this.busy) this.processNext();
    });
  }

  private processNext() {
    const job = this.q.shift();
    if (!job) {
      this.busy = false;
      return;
    }

    this.busy = true;
    const { fen, resolve, reject } = job;
    this.currentResolve = resolve;
    this.currentReject = reject;
    this.currentFen = fen;
    this.currentLines = [];

    const cmd = `position fen ${fen}`;
    this.proc.stdin.write(cmd + "\n");
    this.proc.stdin.write(`go movetime ${this.moveTime}\n`);

    // Timeout for stuck analysis
    setTimeout(() => {
      if (this.currentResolve === resolve) {
        this.currentReject?.(new Error(`Analysis timeout for FEN: ${fen}`));
        this.cleanupCurrent();
        this.processNext();
      }
    }, this.moveTime + 1000);
  }

  private cleanupCurrent() {
    this.currentResolve = undefined;
    this.currentReject = undefined;
    this.currentLines = [];
    this.currentFen = undefined;
  }
}

// -------------------------------------------------------------
// EnginePool – simple round-robin dispatcher
// -------------------------------------------------------------
class EnginePool {
  private index = 0;
  constructor(private pool: Engine[]) {}
  async analyze(fen: string) {
    const e = this.pool[this.index++ % this.pool.length];
    return e?.analyze(fen);
  }
  terminate() {
    this.pool.forEach((e) => e.terminate());
  }
}

export function createEnginePool({
  poolSize = 4,
  threadsPer = Math.max(1, Math.floor(osCores() / poolSize)),
  hashMb = 2048,
  multipv = 5,
}: Partial<{
  poolSize: number;
  threadsPer: number;
  hashMb: number;
  multipv: number;
}> = {}): EnginePool {
  const pool = Array.from(
    { length: poolSize },
    () => new Engine(threadsPer, hashMb, multipv)
  );
  return new EnginePool(pool);
}

function osCores() {
  return os.cpus().length;
}

// -------------------------------------------------------------
// Parsing helpers
// -------------------------------------------------------------
interface ParsedInfoLine {
  multipv: number;
  uci: string;
  evaluation: string;
  raw: string;
}

function parseStockfishInfo(line: string): ParsedInfoLine | undefined {
  const m = line.match(
    / multipv (\d+).*? pv ([a-h][1-8][a-h][1-8][qrbn]?(?: [a-h][1-8][a-h][1-8][qrbn]?)*)/
  );
  if (!m?.[1] || !m?.[2]) return; // ignore early / malformed lines
  const multipv = +m[1];
  const firstMoveUci = m[2].split(" ")[0];
  const [scoreType, scoreVal] = (
    line.match(/ score (cp|mate) (-?\d+)/) || []
  ).slice(1);
  if (!scoreType || scoreVal === undefined) return; // ignore incomplete lines
  const evalStr =
    scoreType === "mate" ? `#${scoreVal}` : `${(+scoreVal / 100).toFixed(2)}`;
  if (!firstMoveUci) return;

  return { multipv, uci: firstMoveUci, evaluation: evalStr, raw: line };
}

function uciToSAN(uci: string, fen: string) {
  try {
    const c = new Chess(fen);
    const move = c.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci[4],
    });
    return move?.san ?? uci;
  } catch {
    return uci;
  }
}
