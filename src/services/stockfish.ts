import { Engine } from "node-uci";

let engine: Engine | null = null;

// Initialize engine when starting the game loop
export async function initializeEngine() {
  try {
    engine = new Engine("stockfish");
    await engine.init();
    await engine.setoption("MultiPV", "5"); // Get top 6 moves
    await engine.isready();
    console.log("Stockfish engine initialized");
  } catch (error) {
    console.error("Failed to initialize Stockfish:", error);
  }
}

export async function getStockfishEvaluation(
  fen: string,
  depth: number = 20
): Promise<
  Array<{ move: string; score: number; line: string; depth: number }>
> {
  if (!engine) {
    console.error("Engine not initialized");
    return [];
  }

  try {
    await engine.position(fen);
    const result = await engine.go({ depth });

    const evaluations = new Map<number, any>();

    result.info.forEach((info: any) => {
      if (typeof info === "object" && info.multipv && info.score && info.pv) {
        const currentDepth = info.depth;
        const existingEval = evaluations.get(info.multipv);

        if (!existingEval || existingEval.depth < currentDepth) {
          evaluations.set(info.multipv, {
            depth: currentDepth,
            move: info.pv.split(" ")[0],
            score: info.score.value || 0,
            line: info.pv,
          });
        }
      }
    });

    const sortedEvals = Array.from(evaluations.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    return sortedEvals.map((evaluation) => ({
      move: evaluation.move,
      score: evaluation.score,
      line: evaluation.line,
      depth: evaluation.depth,
    }));
  } catch (error) {
    console.error("Stockfish evaluation error:", error);
    return [];
  }
}

process.on("exit", async () => {
  if (engine) {
    await engine.quit();
  }
});
