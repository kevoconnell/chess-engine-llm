import { Chess } from "chess.js";

import { getGamePhase, evaluateMaterial } from "./lichess";
import openai from "../initalizers/openai";
import { getStockfishEvaluation } from "./stockfish";

async function findSafeMove(chess: Chess): Promise<string> {
  try {
    // Get Stockfish evaluation first
    const stockfishEval = await getStockfishEvaluation(chess.fen());
    return stockfishEval[1]?.move || chess.moves({ verbose: true })[0].san;
  } catch (error) {
    // Fallback to simple move if Stockfish fails
    return chess.moves({ verbose: true })[0].san;
  }
}

export async function generateMove(
  fen: string,
  accountRating: number
): Promise<string> {
  const chess = new Chess(fen);
  const allLegalMoves = chess.moves({ verbose: true });
  const moveCount = chess.moveNumber();

  if (allLegalMoves.length === 0) return "";

  try {
    // Get Stockfish evaluation
    const stockfishEval = await getStockfishEvaluation(fen);

    const prompt = `
        You are a grandmaster chess player trying to hide your true rating while being able to win. Analyze this position:
        FEN: ${fen}
        Move number: ${moveCount}
        
        Stockfish's top moves with evaluations:
        ${stockfishEval
          .map(
            (e, i) => `${i + 1}. ${e.move} (score: ${e.score}, line: ${e.line})`
          )
          .join("\n")}
        
        Consider:
        1. The position's characteristics
        2. The need to play natural, human-like moves
        3. Stockfish's evaluation while maintaining playing style authenticity
        4. The game phase (${getGamePhase(chess)})
        5. Material balance: ${evaluateMaterial(chess)}
        
        Return ONLY a single move in standard algebraic notation.
        Choose a move that balances competitive strength with natural play.
        No explanations.
      `;

    const moveChoice = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: prompt }],
      temperature: 0.35,
      max_tokens: 10,
    });

    const chosenMove = moveChoice.choices[0].message.content?.trim();
    console.log("chosenMove for ", fen, chosenMove);

    // Validate the chosen move
    if (chosenMove && allLegalMoves.some((m) => m.san === chosenMove)) {
      return chosenMove;
    }

    // Fallback to Stockfish's second or third suggestion
    const moveIndex = Math.floor(Math.random() * 2) + 1;
    return stockfishEval[moveIndex]?.move || stockfishEval[0].move;
  } catch (error) {
    console.error("Error in move generation:", error);
    return findSafeMove(chess);
  }
}
