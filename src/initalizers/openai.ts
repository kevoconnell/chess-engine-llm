import OpenAI from "openai";

import dotenv from "dotenv";
import { config } from "../config";

dotenv.config();

const openai = new OpenAI({
  apiKey: config.openai.apiKey,
});

export default openai;
