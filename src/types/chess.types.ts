export interface GameState {
  fen: string;
  lastMove?: string | null;
  isOurTurn: boolean;
  type: "gameStart" | "gameState" | "error" | "status";
  message?: string;
  playerColor?: "white" | "black";
  ratings: {
    white: number;
    black: number;
  };
  timeLeft?: {
    white: number;
    black: number;
  };
  botColor: "white" | "black";
  positionAdvantage?: number;
  chatMessages?: ChatMessage[];
  nextSessionTime?: string;
}

export interface ChatMessage {
  text: string;
  username: string;
  time: string;
}

export interface GameEvent {
  type: "gameFull" | "gameState";
  id?: string;
  state?: {
    moves: string;
    wtime?: number;
    btime?: number;
    winc?: number;
    binc?: number;
    status: string;
  };
}
