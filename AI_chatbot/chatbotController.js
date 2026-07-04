const express = require('express');
const fs = require('fs');
const path = require('path');
const { getGeminiResponse } = require('./geminiService');

const router = express.Router();

const FAQ_PATH = path.join(__dirname, 'faq.json');

let faqData = [];
try {
  faqData = JSON.parse(fs.readFileSync(FAQ_PATH, 'utf-8'));
}
catch (err) {
  console.error('[AI_chatbot] Failed to load faq.json:', err.message);
}

/**
 * Lightweight keyword scorer — pulls the most relevant FAQ entries
 * to hand to Gemini as grounding context. No embeddings needed for
 * a knowledge base this size.
 */
function findRelevantFaqs(message, limit = 4) {
  const lower = message.toLowerCase();

  const scored = faqData.map((entry) => {
    let score = 0;
    (entry.keywords || []).forEach((kw) => {
      if (lower.includes(kw.toLowerCase())) score += 2;
    });
    if (entry.question && lower.includes(entry.question.toLowerCase())) score += 3;
    return { entry, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.entry);
}

async function handleChatMessage(req, res) {
  try {
    const { message, history } = req.body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ success: false, message: 'Message is required.' });
    }

    const relevantFaqs = findRelevantFaqs(message);
    const reply = await getGeminiResponse({
      message: message.trim(),
      history: Array.isArray(history) ? history : [],
      relevantFaqs,
    });

    return res.json({ success: true, reply });
  } catch (err) {
    console.error('[AI_chatbot] handleChatMessage error:', err.message);
    // Graceful fallback so the widget never shows a raw error
    return res.json({
      success: true,
      reply:
        "Sorry, I'm having trouble reaching my knowledge base right now 🤖 — try again in a moment, or check the Support panel.",
      fallback: true,
    });
  }
}

// POST /api/ai-chatbot/message
// body: { message: string, history?: [{role: 'user'|'bot', text: string}] }
router.post('/api/ai-chatbot/message', handleChatMessage);

module.exports = router;