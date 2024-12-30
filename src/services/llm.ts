import { Chess } from "chess.js";

import { getGamePhase, evaluateMaterial } from "./lichess";
import openai from "../initalizers/openai";
import { getStockfishEvaluation } from "./stockfish";

// Add constants for evaluation thresholds
const EVAL_THRESHOLDS = {
  BLUNDER: -300, // More tolerant of material sacrifices
  MISTAKE: -150,
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

// Add new constants for aggressive play
const AGGRESSION_SETTINGS = {
  ATTACK_BONUS: 100, // Bonus points for moves that attack enemy pieces
  CENTER_CONTROL_BONUS: 50, // Bonus for controlling central squares
  FORWARD_MOVEMENT_BONUS: 30, // Bonus for moving pieces towards enemy king
};

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
  } catch (error: any) {
    if (error.message?.toLowerCase().includes("rate limit")) {
      console.log(
        `Rate limited. Waiting ${RATE_LIMIT_DELAY / 1000}s before retry...`
      );
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY));
      return await fn();
    }
    throw error;
  }
}

// Add function to evaluate attacking potential
function evaluateAttackingPotential(chess: Chess, move: string): number {
  const originalPosition = chess.fen();
  chess.move(move);

  let attackScore = 0;
  const moves = chess.moves({ verbose: true });

  // Count attacks against enemy pieces
  moves.forEach((m) => {
    if (m.flags.includes("c")) {
      // Capture
      attackScore += AGGRESSION_SETTINGS.ATTACK_BONUS;
    }
    // Bonus for moves that check the king
    if (m.flags.includes("k")) {
      attackScore += AGGRESSION_SETTINGS.ATTACK_BONUS * 1.5;
    }
  });

  chess.load(originalPosition);
  return attackScore;
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
        You are a world class chess player who loves attacking and sacrificing pieces for initiative.
        Analyzing position: ${fen}
        
        CRITICAL PRIORITIES:
        1. Look for ATTACKING moves first, especially towards the enemy king
        2. Consider piece sacrifices if they lead to strong attacking chances
        3. Prioritize development towards the enemy kingside
        4. Only capture pieces if it doesn't slow down the attack
        
        Secondary Considerations:
        - Maintain attacking pressure even if slightly worse materially
        - Prefer moves that create threats and complications
        - Control central squares to support the attack
        
        Choose ONE move that:
        - Maximizes attacking potential and piece activity
        - Creates tactical complications
        - Matches the playing strength of a world class chess player
        
        Return ONLY the chosen move in standard algebraic notation.
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
