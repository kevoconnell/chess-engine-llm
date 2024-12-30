import { config } from "../config";

// Constants
const LICHESS_BASE_URL = "https://lichess.org/api";

// Types for game events
interface GameEvent {
  type:
    | "gameStart"
    | "gameFinish"
    | "challenge"
    | "challengeCanceled"
    | "challengeDeclined";
  game?: any;
}

class LichessClient {
  private token: string;
  private decoder: TextDecoder;

  constructor(token: string) {
    this.token = token;
    this.decoder = new TextDecoder();
  }

  // Base fetch method with auth headers
  private async fetch(endpoint: string, options: RequestInit = {}) {
    const headers = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/x-ndjson",
      ...options.headers,
    };

    return fetch(`${LICHESS_BASE_URL}${endpoint}`, {
      ...options,
      headers,
    });
  }

  // Stream game events
  async *streamGameEvents(gameId: string) {
    const response = await this.fetch(`/board/game/stream/${gameId}`);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Process the NDJSON stream
      const lines = this.decoder.decode(value).split("\n");
      for (const line of lines) {
        if (line.trim()) {
          try {
            yield JSON.parse(line);
          } catch (e) {
            console.error("Failed to parse game event:", e);
          }
        }
      }
    }
  }

  // Stream all events
  async *streamEvents() {
    const response = await this.fetch("/stream/event");
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Process the NDJSON stream
      const lines = this.decoder.decode(value).split("\n");
      for (const line of lines) {
        if (line.trim()) {
          try {
            const event = JSON.parse(line) as GameEvent;
            yield event;
          } catch (e) {
            console.error("Failed to parse event:", e);
          }
        }
      }
    }
  }
}

const lichess = new LichessClient(config.api.lichess.apiKey as string);

export default lichess;
