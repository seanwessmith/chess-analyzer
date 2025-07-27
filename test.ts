import { Chess } from "chess.js";

export async function analyzePgnPositionsBatch(pgn: string, gameId: number) {
  const chess = new Chess();
  chess.loadPgn(pgn);
  const allMoves = chess.history();

  // Get the starting FEN from the loaded game
  const headers = chess.getHeaders();
  console.log(headers);
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
    if (gameId === 1366) {
      console.log(i, move);
    }
    chess.move(move);

    positions.push({
      ply: i + 1,
      moveSAN: move,
      fen: chess.fen(),
    });
  }
}

const pgn = `[Event "Live Chess"]
[Site "Chess.com"]
[Date "2020.12.12"]
[Round "?"]
[White "jamonies"]
[Black "seanwessmith"]
[Result "0-1"]
[SetUp "1"]
[FEN "rnbqkbnr/pppppppp/8/8/8/8/1PPPP3/RNBQKBNR w KQkq - 0 1"]
[TimeControl "180+2"]
[WhiteElo "800"]
[BlackElo "872"]
[Termination "seanwessmith won by resignation"]
[ECO "B00"]
[EndTime "2:09:25 GMT+0000"]
[Link "https://www.chess.com/game/live/5945152177?move=17"]

1. e4 e6 2. Nf3 Nc6 3. Nc3 b6 4. d4 Bb7 5. Nb5 Bb4+ 6. Qd2 Bxd2+ 7. Bxd2 Nf6 8.
Nh4 Nxe4 9. Ra3 Nxd2 10. Kxd2 Qg5+ 11. Kc3 Qxb5 12. Kd2 Nxd4 13. Bxb5 Nxb5 14.
c4 Nxa3 15. bxa3 c6 16. Re1 b5 17. Ng6 Rf8 18. Nxf8 Kxf8 19. cxb5 cxb5 20. Re5
a6 21. Rg5 Rc8 22. Rc5 Rxc5 0-1`;

analyzePgnPositionsBatch(pgn, 1366);
