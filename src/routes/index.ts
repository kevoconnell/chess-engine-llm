import express from "express";

import {
  addSSEClient,
  getGameState,
  removeSSEClient,
} from "../services/lichess";

const router = express.Router();

router.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Send initial state
  const currentState = getGameState();
  if (currentState) {
    res.write(`event: gameState\n`);
    res.write(`data: ${JSON.stringify(currentState)}\n\n`);
  }

  // Add this client to SSE subscribers
  const clientId = Date.now();
  addSSEClient(clientId, res);

  // Remove client when connection closes
  req.on("close", () => {
    removeSSEClient(clientId);
  });
});

router.get("/health", (req, res) => {
  res.status(200).json({ message: "API is running" });
});

export default router;
