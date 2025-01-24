import { deepseek } from 'ollama';

export async function getGameAnalysis(prompt: string) {
  const response = await deepseek('query your game here');
  return response.data;
}

// Global setup code...
