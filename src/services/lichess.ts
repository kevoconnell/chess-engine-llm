import { Chess, Square } from "chess.js";
import { WebSocket, WebSocketServer } from "ws";
import lichess from "../initalizers/lichess";
import express from "express";
import cron from "node-cron";

import { ChatCompletionMessage } from "openai/resources/chat";
import { GameEvent, GameState } from "../types/chess.types";
import { initializeEngine } from "./stockfish";
import { generateMove } from "./llm";
import { config } from "../config";

const BOT_USERNAME = config.api.lichess.botUsername;

const sseClients = new Map<number, express.Response>();

let currentGameState: GameState | null = null;

const broadcastGameState = (gameState: GameState): void => {
  // Ensure chat messages are always present
  const stateWithChat = {
    ...gameState,
    chatMessages: gameState.chatMessages || [],
  };

  // Store current state
  currentGameState = stateWithChat;

  // Broadcast to SSE clients
  sseClients.forEach((client) => {
    client.write(`event: gameState\n`);
    client.write(`data: ${JSON.stringify(stateWithChat)}\n\n`);
  });
};

// Add getter for current game state
export function getGameState(): GameState | null {
  return currentGameState;
}

// Add at the top with other state variables
let isInGame = false;

// Modify the state tracking
let activeGames = new Set<string>();

// Add these constants at the top of the file
const INITIAL_BACKOFF = 5000; // 5 seconds

const RETRY_DELAY = 1000; // 1 second
const MAX_RETRIES = 20;

const PLAY_SCHEDULE = {
  START_HOUR: 8, // 8 AM
  END_HOUR: 23, // 11 PM
  MAX_GAMES_PER_SESSION: 10,
  SESSION_LENGTH_HOURS: 3,
  BREAK_LENGTH_HOURS: 1,
};

let gamesPlayedInSession = 0;
let sessionStartTime: Date | null = null;
let nextSessionTime: Date | null = null;

const CRON_SCHEDULES = {
  DAILY_START: "0 8 * * *",
  DAILY_END: "0 23 * * *",
  SESSION_BREAK: "0 */4 * * *",
};

// Add at the top with other constants
const RATE_LIMIT = {
  COOLDOWN_PERIOD: 60000, // 1 minute in milliseconds
  MAX_RETRIES: 3,
};

// Add global rate limiting state
let isRateLimited = false;
let rateLimitResetTime: number | null = null;

// Add rate limit queue
const requestQueue: Array<() => Promise<void>> = [];
let isProcessingQueue = false;

// Add queue processor
async function processRequestQueue() {
  if (isProcessingQueue || requestQueue.length === 0) return;

  isProcessingQueue = true;

  while (requestQueue.length > 0) {
    if (isRateLimited) {
      const waitTime = rateLimitResetTime
        ? rateLimitResetTime - Date.now()
        : RATE_LIMIT.COOLDOWN_PERIOD;
      console.log(
        `Rate limited. Waiting ${Math.ceil(
          waitTime / 1000
        )} seconds before resuming...`
      );
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      isRateLimited = false;
      rateLimitResetTime = null;
    }

    const request = requestQueue.shift();
    if (request) {
      try {
        await request();
        // Add small delay between requests
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        console.error("Request failed:", error);
      }
    }
  }

  isProcessingQueue = false;
}

function parseRetryAfter(response: Response): number {
  const retryAfterMs = response.headers.get("Retry-After-Ms");
  if (retryAfterMs) {
    return parseInt(retryAfterMs);
  }

  const retryAfter = response.headers.get("Retry-After");
  return retryAfter ? parseInt(retryAfter) * 1000 : INITIAL_BACKOFF;
}

async function handleRateLimit(
  response: Response,
  retryCount: number
): Promise<void> {
  if (retryCount >= MAX_RETRIES) {
    throw new Error("Max retries reached");
  }

  const waitTime = parseRetryAfter(response);
  console.log(`Rate limited. Retrying in ${waitTime / 1000} seconds...`);
  await new Promise((resolve) => setTimeout(resolve, waitTime));
}

async function handleGame(gameId: string) {
  try {
    if (activeGames.size > 0) {
      console.log("Already in a game, declining game:", gameId);
      return;
    }
    activeGames.add(gameId);
    isInGame = true;

    console.log(`Game link: https://lichess.org/${gameId}`);

    // Reduce initial delay to 100-300ms for first move
    const startDelay = Math.random() * 200 + 100;
    await new Promise((resolve) => setTimeout(resolve, startDelay));

    // Fetch account rating with rate limit handling
    const ratingResponse = await fetch("https://lichess.org/api/account", {
      headers: { Authorization: `Bearer ${config.api.lichess.apiKey}` },
    });

    if (ratingResponse.status === 429) {
      await handleRateLimit(ratingResponse, 0);
      return handleGame(gameId); // Retry the entire game handling
    }

    const accountInfo = await ratingResponse.json();
    const currentRating = accountInfo.perfs.rapid.rating || 1500;
    console.log("Current rating:", currentRating);

    // Set up both game and chat streams
    const [gameStream, chatStream] = await Promise.all([
      fetch(`https://lichess.org/api/board/game/stream/${gameId}`, {
        headers: { Authorization: `Bearer ${config.api.lichess.apiKey}` },
      }),
      fetch(`https://lichess.org/api/board/game/${gameId}/chat`, {
        headers: { Authorization: `Bearer ${config.api.lichess.apiKey}` },
      }),
    ]);

    if (!gameStream.ok || !chatStream.ok) {
      throw new Error("Failed to connect to game or chat stream");
    }

    // Handle chat stream in parallel
    const chatReader = chatStream.body?.getReader();
    if (chatReader) {
      (async () => {
        let chatBuffer = "";
        while (true) {
          const { done, value } = await chatReader.read();
          if (done) break;

          chatBuffer += new TextDecoder().decode(value);
          const lines = chatBuffer.split("\n");
          chatBuffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const chatEvent = JSON.parse(line);

              if (
                chatEvent.type === "chatLine" &&
                chatEvent.username !== BOT_USERNAME
              ) {
                console.log("Processing chat from:", chatEvent.username); // Debug log
              }
            } catch (e) {
              console.error("Error processing chat event:", e);
            }
          }
        }
      })().catch(console.error);
    }

    // Stream the game events
    const reader = gameStream.body?.getReader();
    if (!reader) throw new Error("Failed to get stream reader");

    let buffer = "";
    let initialState: any = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        console.log("Stream ended");
        break;
      }

      // Decode the chunk and add it to our buffer
      buffer += new TextDecoder().decode(value);

      // Split on newlines and process each complete line
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const gameEvent = JSON.parse(line) as GameEvent;

          if (gameEvent.type === "gameFull") {
            initialState = gameEvent; // Store the initial state
            // Handle initial game state
            if (gameEvent.state) {
              await processGameState(gameEvent, gameId, currentRating);
            }
          } else if (gameEvent.type === "gameState") {
            const fullState = { ...initialState, state: gameEvent };
            await processGameState(fullState, gameId, currentRating);
          }
        } catch (e) {
          console.error("Error processing game event:", e);
          console.error("Problematic line:", line);
        }
      }
    }
  } catch (error) {
    console.error(`Error in game ${gameId}:`, error);
    broadcastGameState({
      type: "error",
      message: "Game error occurred",
      fen: "",
      isOurTurn: false,
      ratings: { white: 0, black: 0 },
      botColor: "white",
    });
  } finally {
    activeGames.delete(gameId);
    isInGame = false;

    // Add seek logic when game ends (especially for aborted games)
    const seekDelay = Math.random() * 1000 + 500; // Short delay before seeking
    setTimeout(() => {
      if (!isInGame && activeGames.size === 0) {
        console.log("Game ended, seeking new game after short delay...");
        seekGame().catch(console.error);
      }
    }, seekDelay);
  }
}

async function processGameState(
  state: any,
  gameId: string,
  currentRating: number
) {
  if (!state) {
    console.log("Invalid game state received - state is null");
    return;
  }

  // Check if game is over
  const gameStatus = state.state?.status || state.status;
  if (
    gameStatus &&
    ["mate", "resign", "stalemate", "draw", "timeout", "aborted"].includes(
      gameStatus
    )
  ) {
    console.log(`Game ${gameId} ended with status: ${gameStatus}`);

    // Broadcast final game state with chat messages
    broadcastGameState({
      type: "gameState",
      fen: state.state?.fen || "",
      lastMove: undefined,
      isOurTurn: false,
      message: `Game ended: ${gameStatus}`,
      ratings: {
        white: state.white?.rating || 0,
        black: state.black?.rating || 0,
      },
      botColor: state.white?.id === BOT_USERNAME ? "white" : "black",
      chatMessages: state.chat || [],
    });

    // Clear game status
    isInGame = false;
    activeGames.delete(gameId);

    const seekDelay = Math.random() * 2000 + 1000;
    setTimeout(() => {
      if (!isInGame && activeGames.size === 0) {
        console.log("Initiating new game seek...");
        seekGame().catch(console.error);
      }
    }, seekDelay);

    return;
  }

  const moves = (state.state?.moves || state.moves || "").trim();
  const moveList = moves.split(" ").filter((m: string) => m);
  const lastMove = moveList[moveList.length - 1];

  const chess = new Chess();

  // Apply all moves to get to current position
  try {
    for (const move of moveList) {
      chess.move({
        from: move.substring(0, 2),
        to: move.substring(2, 4),
        promotion: move.length === 5 ? move.substring(4, 5) : undefined,
      });
    }
  } catch (error) {
    console.error("Error applying moves:", error);
    return;
  }

  const botId = BOT_USERNAME;
  const isPlayingWhite = state.white?.id === botId;
  const moveCount = moveList.length;
  const isOurTurn = isPlayingWhite ? moveCount % 2 === 0 : moveCount % 2 === 1;

  // Create base game state
  const gameState: GameState = {
    type: "gameState",
    fen: chess.fen(),
    lastMove,
    isOurTurn,
    playerColor: isPlayingWhite ? "white" : "black",
    ratings: {
      white: state.white?.rating || 0,
      black: state.black?.rating || 0,
    },
    timeLeft: {
      white: state.state?.wtime || 0,
      black: state.state?.btime || 0,
    },
    botColor: isPlayingWhite ? "white" : "black",
    positionAdvantage: evaluatePosition(chess),
    chatMessages: [], // Initialize empty chat messages array
  };

  // If there are chat messages in the state, add them
  if (state.chat) {
    gameState.chatMessages = state.chat.map((msg: any) => ({
      text: msg.text,
      username: msg.username,
      time: new Date(msg.time).toISOString(),
    }));
  }

  // Broadcast the game state
  broadcastGameState(gameState);

  // Make move if it's our turn
  if (isOurTurn) {
    try {
      const delay = getRandomDelay(moveCount);
      await new Promise((resolve) => setTimeout(resolve, delay));

      const move = await generateMove(chess.fen(), currentRating);
      const uciMove = convertToUCI(move, chess);

      await makeMove(gameId, uciMove);

      // The next state update will come through the game stream
    } catch (error) {
      console.error("Error in move generation/execution:", error);
    }
  }

  if (currentGameState) {
    broadcastGameState(currentGameState);
  }
}

// Add this function to initialize cron jobs
function initializeScheduler() {
  // Daily start schedule
  cron.schedule(CRON_SCHEDULES.DAILY_START, () => {
    sessionStartTime = new Date();
    gamesPlayedInSession = 0;
    seekGame();
  });

  // Daily end schedule
  cron.schedule(CRON_SCHEDULES.DAILY_END, () => {
    isInGame = false;
    activeGames.clear();
  });

  // Session break schedule
  cron.schedule(CRON_SCHEDULES.SESSION_BREAK, () => {
    if (!isInGame && activeGames.size === 0) {
      sessionStartTime = new Date();
      gamesPlayedInSession = 0;
      seekGame();
    }
  });
}

// Modify startGameLoop to initialize scheduler
async function startGameLoop() {
  await initializeEngine();
  initializeScheduler();
  try {
    // Start seeking a game
    await seekGame();

    // Stream all events
    for await (const event of lichess.streamEvents()) {
      switch (event.type) {
        case "gameStart":
          await handleGame(event.game.id);
          break;
        case "gameFinish":
          console.log("Game finished, seeking new game...");
          await seekGame();
          break;
        default:
          console.log("Received event:", event.type);
      }
    }
  } catch (error) {
    console.error("Error in game loop:", error);
    // Retry after delay
    setTimeout(startGameLoop, 5000);
  }
}

// Modify makeMove function to handle rate limits
async function makeMove(gameId: string, move: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const request = async () => {
      try {
        const response = await fetch(
          `https://lichess.org/api/board/game/${gameId}/move/${move}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.api.lichess.apiKey}`,
              "Content-Type": "application/json",
            },
            signal: AbortSignal.timeout(5000),
          }
        );

        if (response.status === 429) {
          isRateLimited = true;
          const retryAfter = response.headers.get("Retry-After");
          if (retryAfter) {
            rateLimitResetTime = Date.now() + parseInt(retryAfter) * 1000;
          } else {
            rateLimitResetTime = Date.now() + RATE_LIMIT.COOLDOWN_PERIOD;
          }
          throw new Error("Rate limited");
        }

        if (!response.ok) {
          throw new Error(
            `Failed to make move: ${response.status} ${response.statusText}`
          );
        }

        const responseText = await response.text();
        resolve(responseText ? JSON.parse(responseText) : null);
      } catch (error) {
        console.error("Error in make move:", error);
        reject(error);
      }
    };

    requestQueue.push(request);
    processRequestQueue();
  });
}

// Modify seekGame function to handle rate limits
async function seekGame(retryCount = 0): Promise<void> {
  if (isInGame || activeGames.size > 0) return;

  const now = new Date();
  const currentHour = now.getHours();

  // Check if we're within playing hours
  if (
    currentHour < PLAY_SCHEDULE.START_HOUR ||
    currentHour >= PLAY_SCHEDULE.END_HOUR
  ) {
    const nextPlayTime = new Date();
    nextPlayTime.setHours(PLAY_SCHEDULE.START_HOUR, 0, 0, 0);
    if (currentHour >= PLAY_SCHEDULE.END_HOUR) {
      nextPlayTime.setDate(nextPlayTime.getDate() + 1);
    }

    const timeUntilNextSession = nextPlayTime.getTime() - now.getTime();

    broadcastGameState({
      type: "status",
      message: "Taking a break for the night. Will return tomorrow at 8 AM!",
      nextSessionTime: nextPlayTime.toISOString(),
      fen: "",
      isOurTurn: false,
      ratings: { white: 0, black: 0 },
      botColor: "white",
    });

    console.log(`Outside playing hours. Next session at ${nextPlayTime}`);

    // Add timeout to resume play
    setTimeout(() => seekGame(), timeUntilNextSession);
    return;
  }

  // Session break logic
  const sessionLength = sessionStartTime
    ? (new Date().getTime() - sessionStartTime.getTime()) / (1000 * 60 * 60)
    : 0;

  if (
    (sessionLength >= PLAY_SCHEDULE.SESSION_LENGTH_HOURS ||
      gamesPlayedInSession >= PLAY_SCHEDULE.MAX_GAMES_PER_SESSION) &&
    !isInGame &&
    activeGames.size === 0
  ) {
    nextSessionTime = new Date(
      now.getTime() + PLAY_SCHEDULE.BREAK_LENGTH_HOURS * 60 * 60 * 1000
    );

    const timeUntilNextSession = nextSessionTime.getTime() - now.getTime();

    broadcastGameState({
      type: "status",
      message: `Taking a ${
        PLAY_SCHEDULE.BREAK_LENGTH_HOURS
      } hour break. Back at ${nextSessionTime.toISOString()}`,
      nextSessionTime: nextSessionTime.toISOString(),
      fen: "",
      isOurTurn: false,
      ratings: { white: 0, black: 0 },
      botColor: "white",
    });

    console.log(
      `Session ended. Next session at ${nextSessionTime.toISOString()}`
    );

    sessionStartTime = null;
    gamesPlayedInSession = 0;

    // Add timeout to resume play after break
    setTimeout(() => {
      sessionStartTime = new Date();
      gamesPlayedInSession = 0;
      seekGame();
    }, timeUntilNextSession);
    return;
  }

  return new Promise((resolve, reject) => {
    const request = async () => {
      try {
        const response = await fetch("https://lichess.org/api/board/seek", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.api.lichess.apiKey}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            rated: "true",
            time: "10",
            increment: "5",
            color: "random",
          }),
        });

        if (response.status === 429) {
          isRateLimited = true;
          const retryAfter = response.headers.get("Retry-After");
          if (retryAfter) {
            rateLimitResetTime = Date.now() + parseInt(retryAfter) * 1000;
          } else {
            rateLimitResetTime = Date.now() + RATE_LIMIT.COOLDOWN_PERIOD;
          }
          throw new Error("Rate limited");
        }

        if (!response.ok) {
          throw new Error(`Failed to seek game: ${response.statusText}`);
        }

        gamesPlayedInSession++;
        resolve();
      } catch (error) {
        console.error("Error in seek game:", error);
        reject(error);
      }
    };

    requestQueue.push(request);
    processRequestQueue();
  });
}

// New helper functions for position evaluation
export function evaluateMaterial(chess: Chess): string {
  const position = chess.board();
  const values: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  let white = 0;
  let black = 0;

  position.forEach((row) => {
    row.forEach((piece) => {
      if (piece) {
        const value = values[piece.type.toLowerCase()];
        if (piece.color === "w") white += value;
        else black += value;
      }
    });
  });

  return `White: ${white}, Black: ${black}, Difference: ${white - black}`;
}

export function getGamePhase(
  chess: Chess
): "opening" | "middlegame" | "endgame" {
  const position = chess.board();
  let pieceCount = 0;
  let queensPresent = false;

  position.forEach((row) => {
    row.forEach((piece) => {
      if (piece && piece.type !== "k") {
        pieceCount++;
        if (piece.type === "q") queensPresent = true;
      }
    });
  });

  if (pieceCount >= 12 && queensPresent) return "opening";
  if (pieceCount <= 6) return "endgame";
  return "middlegame";
}

// Add this helper function
function convertToUCI(move: string, chess: Chess): string {
  try {
    // Clean the move string by removing check/mate symbols
    const cleanMove = move.replace(/[+#]/, "");

    // If the move is already in UCI format, return it
    if (/^[a-h][1-8][a-h][1-8][qrbnQRBN]?$/.test(cleanMove)) return cleanMove;

    // Find the move in the list of legal moves
    const legalMoves = chess.moves({ verbose: true });

    // Try to find the move by comparing both with and without check/mate symbols
    const matchingMove = legalMoves.find(
      (m) =>
        m.san === cleanMove ||
        m.san === move ||
        m.san.replace(/[+#]/, "") === cleanMove
    );

    if (!matchingMove) {
      console.error("Move validation failed:", {
        attemptedMove: move,
        cleanMove,
        legalMoves: legalMoves.map((m) => ({
          san: m.san,
          from: m.from,
          to: m.to,
        })),
      });
      throw new Error(`Invalid move: ${move}`);
    }

    // Construct UCI move
    const uciMove =
      matchingMove.from + matchingMove.to + (matchingMove.promotion || "");

    return uciMove;
  } catch (error: any) {
    console.error("Error in convertToUCI:", {
      move,
      position: chess.fen(),
      error: error?.message,
      legalMoves: chess.moves(),
    });
    throw error;
  }
}

function getRandomDelay(moveNumber: number): number {
  const baseDelay = Math.random() * 1000 + 1000;

  if (moveNumber >= 10) {
    return baseDelay + Math.random() * 1000;
  }

  return baseDelay;
}

export function addSSEClient(id: number, res: express.Response) {
  sseClients.set(id, res);
}

export function removeSSEClient(id: number) {
  sseClients.delete(id);
}

export { startGameLoop };

// Add helper functions to check game status
export function isPlayingGame(): boolean {
  return activeGames.size > 0;
}

export function getActiveGameIds(): string[] {
  return Array.from(activeGames);
}

function evaluatePosition(chess: Chess): number {
  const position = chess.board();
  const values = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  let score = 0;

  position.forEach((row) => {
    row.forEach((piece) => {
      if (piece) {
        const value = values[piece.type.toLowerCase() as keyof typeof values];
        score += piece.color === "w" ? value : -value;
      }
    });
  });

  return score;
}
