import express from "express";
import cors from "express";
import {
  startGameLoop,
  getGameState,
  addSSEClient,
  removeSSEClient,
} from "./services/lichess";

const app = express();

// Enable CORS
app.use(cors());

app.use("/api", require("./routes").default);
// SSE endpoint for game events

// Start the bot
startGameLoop().catch(console.error);

app.listen(process.env.PORT || 4000, () => {
  console.log(`Server running on http://localhost:${process.env.PORT || 4000}`);
});
