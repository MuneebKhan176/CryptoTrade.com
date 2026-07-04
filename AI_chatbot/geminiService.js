const fs = require('fs');
const path = require('path');

// GEMINI_API_KEY lives in routes/.env — point dotenv there explicitly
require('dotenv').config({ path: path.join(__dirname, '../routes/.env') });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Load the system prompt from requirements.txt
const REQUIREMENTS_PATH = path.join(__dirname, 'requirements.txt');


// Reading the initial commands from the requirements.txt

let SYSTEM_PROMPT = '';

try {
  SYSTEM_PROMPT = fs.readFileSync(REQUIREMENTS_PATH, 'utf8').trim();
} catch (err) {
  console.error('[AI_chatbot] Failed to load requirements.txt:', err.message);
  SYSTEM_PROMPT = 'You are a helpful AI assistant.';
}

function buildContextBlock(relevantFaqs) {
  if (!relevantFaqs || relevantFaqs.length === 0) {
    return 'No specific FAQ entry matched this question — answer using the general platform description above, or say you\'re not sure.';
  }

  return relevantFaqs
    .map((f, i) => `${i + 1}. Q: ${f.question}\n   A: ${f.answer}`)
    .join('\n');
}

// Receives the response from the Gemini API


async function getGeminiResponse({ message, history, relevantFaqs }) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set in routes/.env');
  }

  const contents = [];

  (history || []).slice(-6).forEach((turn) => {
    contents.push({
      role: turn.role === 'user' ? 'user' : 'model',
      parts: [{ text: turn.text }],
    });
  });

  contents.push({
    role: 'user',
    parts: [{ text: message }],
  });

  const body = {
    system_instruction: {
      parts: [
        {
          text: `${SYSTEM_PROMPT}

Relevant knowledge base entries:
${buildContextBlock(relevantFaqs)}`,
        },
      ],
    },
    contents,
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 300,
    },
  };

  const resp = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();

  const text =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';

  if (!text.trim()) {
    throw new Error('Empty response from Gemini.');
  }

  return text.trim();
}

module.exports = { getGeminiResponse };