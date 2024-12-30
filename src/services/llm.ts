import { Chess } from "chess.js";

import { getGamePhase, evaluateMaterial } from "./lichess";
import openai from "../initalizers/openai";
import { getStockfishEvaluation } from "./stockfish";

// Add constants for evaluation thresholds
const EVAL_THRESHOLDS = {
  BLUNDER: -200, // centipawns
  MISTAKE: -100,
  GOOD_MOVE: 50,
  EXCELLENT: 150,
};

const PHASE_WEIGHTS = {
  opening: 0.7, // Higher weight on book moves and development
  middlegame: 0.8, // Balance between tactics and strategy
  endgame: 0.9, // Higher weight on precise moves
};

const PIECE_VALUES = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};

const DEBUG = true;
const RATE_LIMIT_DELAY = 5000; // 5 seconds

function findBestCapture(chess: Chess): string | null {
  const moves = chess.moves({ verbose: true });
  let bestCapture = null;
  let bestValue = 0;

  for (const move of moves) {
    if (move.captured) {
      const captureValue = PIECE_VALUES[move.captured];
      const pieceValue = PIECE_VALUES[move.piece];

      // Calculate simple exchange value
      chess.move(move.san);
      const isDefended = chess.moves().some((m) => m.endsWith(move.to));
      chess.undo();

      const exchangeValue = isDefended
        ? captureValue - pieceValue
        : captureValue;

      if (exchangeValue > bestValue) {
        bestValue = exchangeValue;
        bestCapture = move.san;
      }
    }
  }

  return bestCapture;
}

async function findSafeMove(chess: Chess): Promise<string> {
  try {
    const stockfishEval = await getStockfishEvaluation(chess.fen());
    // Pick from top 3 moves to add variety while ensuring safety
    const safeIndex = Math.floor(
      Math.random() * Math.min(3, stockfishEval.length)
    );
    return (
      stockfishEval[safeIndex]?.move || chess.moves({ verbose: true })[0].san
    );
  } catch (error) {
    return chess.moves({ verbose: true })[0].san;
  }
}

async function withRateLimit<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error.message?.includes("rate limit")) {
      console.log(
        `Rate limited. Waiting ${RATE_LIMIT_DELAY / 1000}s before retry...`
      );
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY));
      return await fn();
    }
    throw error;
  }
}

export async function generateMove(
  fen: string,
  accountRating: number
): Promise<string> {
  return withRateLimit(async () => {
    if (DEBUG) console.log(`Analyzing position: ${fen}`);

    const chess = new Chess(fen);

    // Add debugging for captures
    const bestCapture = findBestCapture(chess);
    if (bestCapture) {
      console.log(`Found potential capture: ${bestCapture}`);
    }

    // Add debugging for Stockfish evaluation
    const stockfishEval = await getStockfishEvaluation(fen);
    if (DEBUG) {
      console.log(
        "Stockfish evaluation:",
        stockfishEval.map((e) => `${e.move}: ${e.score}`).join(", ")
      );
    }

    const allLegalMoves = chess.moves({ verbose: true });
    const moveCount = chess.moveNumber();
    const gamePhase = getGamePhase(chess);

    if (allLegalMoves.length === 0) return "";

    try {
      // Calculate position complexity and material balance
      const materialBalance = evaluateMaterial(chess);
      const isComplexPosition = stockfishEval.some(
        (evaluation, index) =>
          index > 0 && Math.abs(evaluation.score - stockfishEval[0].score) < 50
      );

      const prompt = `
        You are a ${accountRating}-rated chess player analyzing this position:
        FEN: ${fen}
        Move: ${moveCount}
        Phase: ${gamePhase}
        Material: ${materialBalance}
        
        Stockfish's top moves (depth ${stockfishEval[0]?.depth || 20}):
        ${stockfishEval
          .map(
            (e, i) => `${i + 1}. ${e.move} (score: ${e.score}, line: ${e.line})`
          )
          .join("\n")}
        
        CRITICAL PRIORITIES:
        1. IMMEDIATELY CAPTURE ANY UNDEFENDED PIECES, especially high-value pieces like queens and rooks
        2. Check if any pieces can be won through simple tactics (forks, pins, skewers)
        3. Verify if any pieces are hanging or can be captured safely
        
        Secondary Considerations:
        - Position is ${isComplexPosition ? "complex" : "straightforward"}
        - Game phase weight: ${PHASE_WEIGHTS[gamePhase]}
        - Maintain a natural, human-like playing style
        - Consider positional elements only after checking for tactical opportunities
        
        Analysis Process:
        1. First, scan for ANY possible captures, especially of high-value pieces
        2. Check if any tactical patterns exist that win material
        3. Only after confirming no immediate tactical opportunities, consider positional play
        
        Choose ONE move that:
        - Prioritizes material gains and tactical opportunities
        - Avoids blunders (moves that lose more than ${
          EVAL_THRESHOLDS.BLUNDER
        } centipawns)
        - Matches the playing strength of a ${accountRating}-rated player while maximizing winning chances
        
        Return ONLY the chosen move in standard algebraic notation (e.g., 'e4', 'Nf6').
      `;

      const moveChoice = await openai.chat.completions.create({
        model: "o1-mini",
        messages: [{ role: "user", content: prompt }],
      });

      const chosenMove = moveChoice.choices[0].message.content?.trim();

      // Validate the chosen move and check if it's reasonable
      if (chosenMove && allLegalMoves.some((m) => m.san === chosenMove)) {
        // Find the evaluation of the chosen move
        const chosenMoveEval = stockfishEval.find((e) => e.move === chosenMove);
        const topMoveScore = stockfishEval[0].score;

        // If the chosen move is significantly worse than the best move, fall back to a safer option
        if (
          chosenMoveEval &&
          chosenMoveEval.score < topMoveScore + EVAL_THRESHOLDS.BLUNDER
        ) {
          return stockfishEval[Math.floor(Math.random() * 2)].move;
        }

        // Log the final move choice
        if (DEBUG) console.log(`Chosen move: ${chosenMove}`);

        return chosenMove;
      }

      // Enhanced fallback mechanism
      const fallbackIndex = Math.min(2, stockfishEval.length - 1);
      return stockfishEval[fallbackIndex]?.move || stockfishEval[0].move;
    } catch (error) {
      console.error("Error in move generation:", error);
      return findSafeMove(chess);
    }
  });
}
