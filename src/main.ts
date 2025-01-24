import { getCompletion } from './llm';

export default function main() {
  const apiKey = require('dotenv').get('OPENAI_API_KEY');
  // ... existing code ...
  const completion = await getCompletion(prompt);
  // ... handle the response ...
}
