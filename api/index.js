require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(
  cors({
    origin: "*", // tighten this to your app's domain once you know it
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ── Anthropic client ──────────────────────────────────────────────────────────
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY, // set this in Vercel's environment variables
});

// ── System prompt for Lumie ───────────────────────────────────────────────────
const LUMIE_SYSTEM_PROMPT = `You are Lumie, a warm and supportive mental health companion for teenagers (ages 13–19).

Your role:
- Listen with empathy and without judgment
- Help teens explore and name their feelings
- Suggest healthy coping strategies (breathing, journaling, movement, talking to a trusted adult)
- Encourage professional help when appropriate
- Keep responses concise, clear, and relatable to teens

Important safety rules you MUST always follow:
1. If a teen expresses thoughts of self-harm, suicide, or harming others — immediately provide the Crisis Text Line (text HOME to 741741) and the 988 Suicide & Crisis Lifeline, and encourage them to tell a trusted adult.
2. Never diagnose mental health conditions.
3. Never replace professional therapy or medical advice.
4. Always remind teens that speaking with a counselor, therapist, or trusted adult is the best path for serious concerns.
5. Keep all conversations private and never ask for personally identifiable information.

Tone: Warm, calm, non-judgmental, age-appropriate. Avoid clinical jargon. Use short paragraphs.`;

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check — lets you confirm the server is running
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Lumie API is running 🌙" });
});

// Main chat endpoint — called by your React Native app
app.post("/api/chat", async (req, res) => {
  try {
    const { messages } = req.body;

    // Basic validation
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array is required" });
    }

    // Only allow user/assistant roles and string content (keep it simple & safe)
    const sanitized = messages
      .filter((m) => ["user", "assistant"].includes(m.role) && typeof m.content === "string")
      .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) })); // cap message length

    if (sanitized.length === 0) {
      return res.status(400).json({ error: "No valid messages provided" });
    }

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: LUMIE_SYSTEM_PROMPT,
      messages: sanitized,
    });

    const reply = response.content[0]?.text ?? "";

    res.json({ reply });
  } catch (err) {
    console.error("Anthropic API error:", err);

    // Don't leak internal error details to the client
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ── Start server (only used locally — Vercel handles this in prod) ─────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Lumie server running on http://localhost:${PORT}`);
});
// ── In-memory bridge message store ───────────────────────────────────────────
// Note: This resets on server restart. For production, use a database.
const bridgeRooms = {};

// Get messages for a room
app.get("/api/bridge/:roomCode", (req, res) => {
  const { roomCode } = req.params;
  const messages = bridgeRooms[roomCode] || [];
  res.json({ messages });
});

// Post a message to a room
app.post("/api/bridge", async (req, res) => {
  try {
    const { roomCode, sender, role, content } = req.body;
    if (!roomCode || !content) {
      return res.status(400).json({ error: "roomCode and content are required" });
    }

    if (!bridgeRooms[roomCode]) {
      bridgeRooms[roomCode] = [];
    }

    const userMessage = {
      id: Date.now().toString(),
      sender,
      role,
      content,
      timestamp: new Date().toISOString(),
    };

    bridgeRooms[roomCode].push(userMessage);

    // Get Lumie to respond
    const systemPrompt = `You are Lumie, a compassionate mediator helping a teen and parent communicate better. 
A message was just sent in their Family Bridge by ${sender} (${role}).
Your job is to:
1. Acknowledge the message warmly
2. Gently reflect the feeling back in a way both parties can understand
3. Optionally suggest a question the other person could ask to better understand

Keep it short (2-4 sentences). Be warm and bridge-building.`;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      messages: [{ role: "user", content: `${systemPrompt}\n\nMessage: "${content}"` }],
    });

    const lumieReply = {
      id: (Date.now() + 1).toString(),
      sender: "Lumie",
      role: "assistant",
      content: response.content[0]?.text ?? "",
      timestamp: new Date().toISOString(),
    };

    bridgeRooms[roomCode].push(lumieReply);

    res.json({ userMessage, lumieMessage: lumieReply });
  } catch (err) {
    console.error("Bridge error:", err);
    res.status(500).json({ error: "Something went wrong." });
  }
});
module.exports = app;
