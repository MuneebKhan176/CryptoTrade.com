const path = require('path');

// GEMINI_API_KEY lives in routes/.env — point dotenv there explicitly
require('dotenv').config({ path: path.join(__dirname, '../routes/.env') });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM_PROMPT = `You are CryptoBot, the in-app assistant for CryptoTrade — a demo (paper-money, educational-only) crypto trading platform. You help users with:
- Account balance & demo funds ($50,000 one-time grant when balance is $0)
- Transferring demo funds between accounts (via account number)
- Reading live market prices/charts (BTC, ETH, SOL, XRP, BNB, USDT, USDC via CoinGecko)
- Account & security info (username, email, account number, 2FA status)
- The Insights feed and Live Chat rooms
- General support / contact info

Rules:
- No real money is ever involved — always clarify this is a demo/educational platform if asked.
- The "Trade" button is not live yet — trading execution is coming soon; only live prices/charts exist today.
- Never invent account balances, transaction history, or account numbers — you don't have access to per-user data. Direct the user to the relevant panel (Overview, Account, Transfer, Demo Funds) to see their own numbers.
- Keep answers short (2-4 sentences), friendly, and practical for a chat widget.
- If you don't know something about the platform, say so plainly rather than guessing.`;

function buildContextBlock(relevantFaqs) {
  if (!relevantFaqs || relevantFaqs.length === 0) {
    return 'No specific FAQ entry matched this question — answer using the general platform description above, or say you\'re not sure.';
  }
  return relevantFaqs
    .map((f, i) => `${i + 1}. Q: ${f.question}\n   A: ${f.answer}`)
    .join('\n');
}

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
  contents.push({ role: 'user', parts: [{ text: message }] });

  const body = {
    system_instruction: {
      parts: [{ text: `${SYSTEM_PROMPT}\n\nRelevant knowledge base entries:\n${buildContextBlock(relevantFaqs)}` }],
    },
    contents,
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 300,
    },
  };

  const resp = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';

  if (!text.trim()) {
    throw new Error('Empty response from Gemini.');
  }

  return text.trim();
}

module.exports = { getGeminiResponse };