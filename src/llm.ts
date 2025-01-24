import { deepseek } from 'ollama';

export async function getCompletion(prompt: string): Promise<string> {
  const response = await deepseek('analyze-position', prompt);
  return response.data.choices[0].message.content;
}

// Add any other necessary code here