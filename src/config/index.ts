import dotenv from "dotenv";
dotenv.config();

export const config = {
  engine: {
    depth: 20,
    multiPV: 3,
  },
  game: {
    initialBackoff: 5000,
    maxBackoff: 300000,
    maxRetries: 5,
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
  },
  api: {
    lichess: {
      baseUrl: "https://lichess.org/api",
      timeout: 5000,
      apiKey: process.env.LICHESS_API_TOKEN,
      botUsername: process.env.LICHESS_BOT_USERNAME,
    },
  },
} as const;
