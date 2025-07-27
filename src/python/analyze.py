import os
import glob
import chess.pgn
import pandas as pd

PGN_DIR = "./pgn"
records = []

# 1) Find PGN files
files = glob.glob(os.path.join(PGN_DIR, "*.pgn"))
if not files:
    raise RuntimeError(f"No .pgn files found in {PGN_DIR!r}")

print(f"Found {len(files)} PGN file(s):")
for f in files:
    print("  ", f)

# 2) Parse every game
for pgn_file in files:
    print(f"\nParsing {pgn_file}…")
    with open(pgn_file, encoding="utf-8") as f:
        count = 0
        while True:
            game = chess.pgn.read_game(f)
            if game is None:
                break
            count += 1

            # ECO
            eco = game.headers.get("ECO", "Unknown")

            # Opening name: prefer the explicit header, else grab from ECOUrl
            opening = game.headers.get("Opening")
            if not opening:
                eco_url = game.headers.get("ECOUrl", "")
                if "/openings/" in eco_url:
                    # take the path segment after /openings/ and replace dashes
                    opening = (
                        eco_url.split("/openings/")[-1].split("?")[0].replace("-", " ")
                    )
                else:
                    opening = "Unknown"

            # Result & move count
            result = game.headers.get("Result", "*")
            moves = list(game.mainline_moves())

            records.append(
                {
                    "ECO": eco,
                    "Opening": opening,
                    "Moves": len(moves),
                    "Result": result,
                    "Game": game,
                }
            )

        print(f"  → {count} game(s) parsed.")

if not records:
    raise RuntimeError("No games parsed! Check your PGN files for valid games.")

# 3) Inspect your DataFrame
df = pd.DataFrame(records)
print("\nDataFrame columns:", df.columns.tolist())
print("Total games:", len(df))

# 4) Quick sanity: top 5 openings
summary = df.groupby("Opening").size().sort_values(ascending=False)
print("\nTop 5 openings by count:\n", summary)

# save to file
summary.to_csv("opening_summary.csv")

# 5) Aggregate your most common tactical errors

# 5.1) Aggregate by opening
agg = (
    df.groupby(["Opening", "Result"])
    .size()
    .reset_index(name="Count")
    .sort_values("Count", ascending=False) 
    .head(10)
    .assign(WinRate=lambda d: d["Count"] / d["Count"].sum())
    .sort_values("WinRate", ascending=False)
    .drop("Count", axis=1)
    .reset_index(drop=True)
    .rename(columns={"Result": "Win"})
    .to_csv("error_summary.csv")
    .style.hide_index()
    .set_table_styles([
        {"selector": "th", "props": "border-bottom: 1px solid black"},
        {"selector": "td", "props": "border-bottom: 1px solid black"},
        {"selector": "th", "props": "text-align: left"},
        {"selector": "td", "props": "text-align: right"},
        {"selector": "th", "props": "font-weight: bold"},
        {"selector": "td", "props": "font-weight: bold"},
        {"selector": "tr:nth-child(odd)", "props": "background-color: #f2f2f2"},
    ])
)
print("\nMost common slips by opening & result:")
print(agg)

# 5.2) Aggregate by ECO
agg = (
  df.groupby(["ECO", "Result"])
      .size()
      .reset_index(name="Count")
      .sort_values("Count", ascending=False)
      .head(10)
      .assign(WinRate=lambda d: d["Count"] / d["Count"].sum())
      .sort_values("WinRate", ascending=False)
      .drop("Count", axis=1)
      .reset_index(drop=True)
      .rename(columns={"Result": "Win"})
      .to_csv("error_summary.csv")
      .style.hide_index()
      .set_table_styles([
          {"selector": "th", "props": "border-bottom: 1px solid black"},
          {"selector": "td", "props": "border-bottom: 1px solid black"},
          {"selector": "th", "props": "text-align: left"},
          {"selector": "td", "props": "text-align: right"},
          {"selector": "th", "props": "font-weight: bold"},
          {"selector": "td", "props": "font-weight: bold"},
          {"selector": "tr:nth-child(odd)", "props": "background-color: #f2f2f2"},
      ])
      .to_csv("error_summary.csv")
)
