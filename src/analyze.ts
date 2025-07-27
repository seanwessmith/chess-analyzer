//--------------------------------------------------------------------
// chess-tactics.ts  (fixed for chess.js ^3.10 and @mliebelt/pgn-parser ^5)
//--------------------------------------------------------------------
import { Chess, type Square, type Color } from "chess.js";
import { parse, type ParseTree } from "@mliebelt/pgn-parser";
import inquirer from "inquirer";

interface ExtendedParseTree extends ParseTree {
  tags?: {
    Link?: string;
  } & ParseTree["tags"];
}

type MonthKey = `${number}-${string}`; // "2024-04"
type Histogram = Record<MonthKey, number>;

/* ───────────────────────────── PGN → SAN array ──────────────────── */
function sanMoves(tree: ParseTree): string[] {
  const result: string[] = [];

  // `tree.moves` is an array of half-move pairs
  for (const move of tree.moves as unknown as ParseTree["moves"]["0"][]) {
    if (move.turn === "w" && move.notation.notation)
      result.push(move.notation.notation);
    if (move.turn === "b" && move.notation.notation)
      result.push(move.notation.notation);
  }
  return result;
}

/* ──────────────────── Tactic-agnostic workhorse ─────────────────── */
export function countTacticOccurrences(
  pgns: string[],
  myUsername: string,
  detectTactic: (g: Chess, san: string, myUsername: string) => boolean
): {
  counts: Histogram;
  links: Record<string, string>;
} {
  const counts: Histogram = {};
  const links = new Map<string, string>();

  for (const blob of pgns) {
    const games = parse(blob, { startRule: "games" }) as ExtendedParseTree[];

    for (const tree of games) {
      const { White, Black, Date: D, UTCDate } = tree.tags ?? {};
      if (White !== myUsername && Black !== myUsername) continue; // not my game

      const { year, month } = D ?? UTCDate ?? { year: "0000", month: "01" };
      if (!year || !month) continue;
      const key = `${year ?? 0}-${month ?? 0}`;

      const chess = new Chess();
      chess.setHeader("White", White ?? "");
      chess.setHeader("Black", Black ?? "");

      for (let i = 0; i < tree.moves.length; i++) {
        const san = sanMoves(tree)[i];
        if (!san) continue; // no SAN for this move
        chess.move(san);
        if (detectTactic(chess, san, myUsername)) {
          counts[key as MonthKey] = (counts[key as MonthKey] || 0) + 1;
          links.set(`${key}-${san}`, `${tree.tags?.Link}?move=${i}`);
        }
      }
    }
  }
  return { counts, links: Object.fromEntries(links) };
}

/* ───────────────── Knight fork on king + queen detector ─────────── */
export const detectKnightKingQueenFork = (
  game: Chess,
  san: string,
  myUsername: string
): boolean => {
  if (!san.startsWith("N")) return false; // not a knight move

  /* Which colour am I?  (stored earlier via setHeader) */
  const { White, Black } = game.getHeaders();
  const myColor =
    White === myUsername ? "w" : Black === myUsername ? "b" : null;
  if (!myColor) return false; // username mismatch

  const last = game.history({ verbose: true }).at(-1);
  if (!last || last.color !== myColor) return false; // NOT my move

  const attackerSq = last.to as Square;
  const attackerColor = myColor as Color; // strictly typed

  /* enemy king & queen squares */
  const pieces = game.board().flat().filter(Boolean) as {
    square: Square;
    type: string;
    color: Color;
  }[];

  const kingSq = pieces.find(
    (p) => p.type === "k" && p.color !== attackerColor
  )?.square;
  const queenSq = pieces.find(
    (p) => p.type === "q" && p.color !== attackerColor
  )?.square;
  if (!kingSq || !queenSq) return false;

  /* does *my* knight hit both? */
  const hitsKing = game.attackers(kingSq, attackerColor).includes(attackerSq);
  const hitsQueen = game.attackers(queenSq, attackerColor).includes(attackerSq);

  return hitsKing && hitsQueen;
};

/* ─────────────────────────────── CLI demo ───────────────────────── */
const tactics = [
  { name: "Knight King Queen Fork", value: detectKnightKingQueenFork },
];
if (import.meta.main) {
  const [myUsername, file] = process.argv.slice(2);
  if (!file || !myUsername) {
    console.error("Usage: bun run chess-tactics.ts <myUsername> <pgn-file>");
    process.exit(1);
  }
  const { tactic } = await inquirer.prompt([
    {
      type: "select",
      name: "tactic",
      message: "Choose a tactic:",
      default: tactics[0]?.name,
      choices: tactics,
    },
  ]);
  const fs = await import("node:fs/promises");
  const data = await fs.readFile(file, "utf8");
  console.table(countTacticOccurrences([data], myUsername, tactic));
}
