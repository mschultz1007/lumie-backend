require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
const { neon } = require("@neondatabase/serverless");

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

// ── Database ──────────────────────────────────────────────────────────────────
// DATABASE_URL must be set in Vercel's environment variables (your Neon connection string).
const sql = neon(process.env.DATABASE_URL);

// ── Limits ────────────────────────────────────────────────────────────────────
const MAX_HISTORY_MESSAGES = 20; // how many recent messages get sent to Claude, regardless of full history length
const FREE_DAILY_LIMIT = 30; // free-tier companion messages per day
const WARNING_THRESHOLD = 24; // show a "running low" warning at this count

// ── Companion personalities ───────────────────────────────────────────────────
// Safety rules are identical across every companion, non-negotiable. Only the
// role description and tone vary — that's what gives each companion a
// genuinely different feel, not just a different avatar.
const SAFETY_RULES = `Important safety rules you MUST always follow:
1. If a teen expresses thoughts of self-harm, suicide, or harming others — immediately provide the Crisis Text Line (text HOME to 741741) and the 988 Suicide & Crisis Lifeline, and encourage them to tell a trusted adult.
2. Never diagnose mental health conditions.
3. Never replace professional therapy or medical advice.
4. Always remind teens that speaking with a counselor, therapist, or trusted adult is the best path for serious concerns.
5. Keep all conversations private and never ask for personally identifiable information.`;

const COMPANIONS = {
  luna: {
    name: "Luna",
    role: `Your role:
- Listen with empathy and without judgment
- Help teens explore and name their feelings
- Suggest healthy coping strategies (breathing, journaling, movement, talking to a trusted adult)
- Encourage professional help when appropriate
- Keep responses concise, clear, and relatable to teens`,
    tone: "Warm, calm, non-judgmental, age-appropriate. Avoid clinical jargon. Use short paragraphs.",
  },
  nova: {
    name: "Nova",
    role: `Your role:
- Be an upbeat, encouraging presence — good for pep talks and finding motivation
- Help teens see their own strengths and past wins
- Suggest small, energizing next steps when someone feels stuck
- Still take real struggles seriously — enthusiasm never means brushing off hard feelings`,
    tone: "Upbeat, playful, and encouraging, but never fake-cheerful about real pain. Short, punchy sentences. Age-appropriate.",
  },
  cosmo: {
    name: "Cosmo",
    role: `Your role:
- Be a calm, curious presence who helps teens untangle big or confusing feelings
- Ask gentle, open-ended questions rather than jumping to advice
- Help someone slow down and notice what they're actually feeling
- Reflect back what you hear before offering any suggestion`,
    tone: "Soft-spoken, thoughtful, curious. Ask more than you tell. Unhurried, gentle pacing.",
  },
  orbit: {
    name: "Orbit",
    role: `Your role:
- Be a steady, grounding presence — especially good for anxiety and calming down
- Offer practical, concrete coping steps (breathing, grounding exercises, simple next actions)
- Keep things simple and calm when someone feels overwhelmed
- Prioritize helping someone feel steady before exploring deeper feelings`,
    tone: "Calm, steady, practical. Simple, grounded language. Never rushed.",
  },
  ember: {
    name: "Ember",
    role: `Your role:
- Be a direct, straight-talking presence — good for venting and honest conversation
- Let teens vent without immediately trying to fix or soften things
- Be honest and confident, while always remaining kind underneath the directness
- Help someone channel frustration into clarity, not just validate it endlessly`,
    tone: "Direct, confident, a little bold — but never harsh, sarcastic, or dismissive. Kindness underneath the bluntness, always.",
  },
};

function buildSystemPrompt(companionId) {
  const companion = COMPANIONS[companionId] || COMPANIONS.luna;
  return `You are ${companion.name}, a supportive mental health companion for teenagers (ages 13–19).

${companion.role}

${SAFETY_RULES}

Tone: ${companion.tone}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Ensures a user row exists, resets their daily count if it's a new day,
// and returns their current usage/entitlement state.
async function getOrResetUser(userId) {
  await sql`
    INSERT INTO users (id) VALUES (${userId})
    ON CONFLICT (id) DO NOTHING
  `;

  const rows = await sql`
    SELECT daily_message_count, count_reset_date, is_pro, is_family_pro
    FROM users
    WHERE id = ${userId}
  `;
  let user = rows[0];

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const resetDate =
    user.count_reset_date instanceof Date
      ? user.count_reset_date.toISOString().slice(0, 10)
      : String(user.count_reset_date);

  if (resetDate !== today) {
    await sql`
      UPDATE users
      SET daily_message_count = 0, count_reset_date = ${today}
      WHERE id = ${userId}
    `;
    user = { ...user, daily_message_count: 0, count_reset_date: today };
  }

  return user;
}

async function incrementUserCount(userId) {
  const rows = await sql`
    UPDATE users
    SET daily_message_count = daily_message_count + 1
    WHERE id = ${userId}
    RETURNING daily_message_count
  `;
  return rows[0].daily_message_count;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check — lets you confirm the server is running
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Lumie API is running 🌙" });
});

// Lets the app check usage/entitlement without sending a chat message
// (used to show the "X messages left today" warning proactively).
app.get("/api/usage/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: "userId is required" });

    const user = await getOrResetUser(userId);
    const isPro = user.is_pro || user.is_family_pro;
    const remaining = isPro ? null : Math.max(0, FREE_DAILY_LIMIT - user.daily_message_count);

    res.json({
      dailyCount: user.daily_message_count,
      limit: isPro ? null : FREE_DAILY_LIMIT,
      remaining,
      isPro: user.is_pro,
      isFamilyPro: user.is_family_pro,
      warning: !isPro && user.daily_message_count >= WARNING_THRESHOLD,
    });
  } catch (err) {
    console.error("Usage check error:", err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// Main chat endpoint — called by your React Native app
app.post("/api/chat", async (req, res) => {
  try {
    const { userId, messages, companionId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    // Basic validation
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array is required" });
    }

    const user = await getOrResetUser(userId);
    const isPro = user.is_pro || user.is_family_pro;

    // Enforce the free daily cap BEFORE calling Claude.
    if (!isPro && user.daily_message_count >= FREE_DAILY_LIMIT) {
      return res.status(403).json({
        error: "daily_limit_reached",
        message: "You've reached today's chat limit. Crisis resources are always available.",
        dailyCount: user.daily_message_count,
        limit: FREE_DAILY_LIMIT,
      });
    }

    // Only allow user/assistant roles and string content (keep it simple & safe)
    const sanitized = messages
      .filter((m) => ["user", "assistant"].includes(m.role) && typeof m.content === "string")
      .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) })); // cap message length

    if (sanitized.length === 0) {
      return res.status(400).json({ error: "No valid messages provided" });
    }

    // Cap how much history gets sent to Claude, no matter how long the
    // conversation has grown client-side. This is what stops per-request
    // token cost from growing unbounded over a long session.
    const trimmed = sanitized.slice(-MAX_HISTORY_MESSAGES);

    // Only Pro users get a companion other than Luna — protects against
    // someone bypassing the in-app lock by calling the API directly.
    const effectiveCompanionId = isPro ? (companionId || "luna") : "luna";

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: buildSystemPrompt(effectiveCompanionId),
      messages: trimmed,
    });

    const reply = response.content[0]?.text ?? "";

    const newCount = await incrementUserCount(userId);

    res.json({
      reply,
      companionId: effectiveCompanionId,
      dailyCount: newCount,
      limit: isPro ? null : FREE_DAILY_LIMIT,
      remaining: isPro ? null : Math.max(0, FREE_DAILY_LIMIT - newCount),
      isPro,
      warning: !isPro && newCount >= WARNING_THRESHOLD,
    });
  } catch (err) {
    console.error("Anthropic API error:", err);

    // Don't leak internal error details to the client
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ── Family Bridge (now persisted in Postgres, not in-memory) ──────────────────

// Get messages for a room
app.get("/api/bridge/:roomCode", async (req, res) => {
  try {
    const { roomCode } = req.params;
    const messages = await sql`
      SELECT id, sender, role, content, created_at AS timestamp
      FROM bridge_messages
      WHERE room_code = ${roomCode}
      ORDER BY created_at ASC
    `;
    res.json({ messages });
  } catch (err) {
    console.error("Bridge fetch error:", err);
    res.status(500).json({ error: "Something went wrong." });
  }
});

// Post a message to a room
app.post("/api/bridge", async (req, res) => {
  try {
    const { roomCode, sender, role, content } = req.body;
    if (!roomCode || !content) {
      return res.status(400).json({ error: "roomCode and content are required" });
    }

    await sql`
      INSERT INTO bridge_rooms (room_code) VALUES (${roomCode})
      ON CONFLICT (room_code) DO NOTHING
    `;

    const [userMessage] = await sql`
      INSERT INTO bridge_messages (room_code, sender, role, content)
      VALUES (${roomCode}, ${sender}, ${role}, ${content})
      RETURNING id, sender, role, content, created_at AS timestamp
    `;

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

    const [lumieMessage] = await sql`
      INSERT INTO bridge_messages (room_code, sender, role, content)
      VALUES (${roomCode}, 'Lumie', 'assistant', ${response.content[0]?.text ?? ""})
      RETURNING id, sender, role, content, created_at AS timestamp
    `;

    res.json({ userMessage, lumieMessage });
  } catch (err) {
    console.error("Bridge error:", err);
    res.status(500).json({ error: "Something went wrong." });
  }
});
// ── RevenueCat webhook ──────────────────────────────────────────────────────
// Configure this URL + a shared secret in the RevenueCat dashboard
// (Project Settings → Integrations → Webhooks). RevenueCat sends the secret
// back as "Authorization: Bearer <secret>" on every request, which we verify
// below so nobody else can call this and grant themselves Pro for free.
//
// Entitlement identifiers must match exactly what's configured in RevenueCat.
// "Lumie Pro" = teen tier. "Lumie Family" = parent tier (once it exists).
const ENTITLEMENT_TO_COLUMN = {
  "Lumie Pro": "is_pro",
  "Lumie Family": "is_family_pro",
};

// Event types that mean "this entitlement is now active"
const ACTIVATING_EVENTS = new Set([
  "INITIAL_PURCHASE",
  "NON_RENEWING_PURCHASE", // one-time purchases (like Lumie Pro's current $4.99 unlock) use this, not INITIAL_PURCHASE
  "RENEWAL",
  "PRODUCT_CHANGE",
  "UNCANCELLATION",
  "SUBSCRIPTION_EXTENDED",
]);

// Event types that mean "this entitlement is no longer active"
// (CANCELLATION alone just means auto-renew was turned off — the entitlement
// stays active until EXPIRATION actually fires, so we don't deactivate on it.)
const DEACTIVATING_EVENTS = new Set(["EXPIRATION"]);

app.post("/api/webhooks/revenuecat", async (req, res) => {
  try {
    const authHeader = req.headers["authorization"] || "";
    const expected = `Bearer ${process.env.REVENUECAT_WEBHOOK_SECRET}`;

    if (!process.env.REVENUECAT_WEBHOOK_SECRET || authHeader !== expected) {
      console.error("RevenueCat webhook: invalid or missing auth header");
      return res.status(401).json({ error: "Unauthorized" });
    }

    const event = req.body?.event;
    if (!event || !event.app_user_id || !event.type) {
      return res.status(400).json({ error: "Malformed event payload" });
    }

    const userId = event.app_user_id;
    const entitlementIds = event.entitlement_ids || [];

    // Figure out which of our columns (if any) this event affects
    const affectedColumns = entitlementIds
      .map((id) => ENTITLEMENT_TO_COLUMN[id])
      .filter(Boolean);

    if (affectedColumns.length === 0) {
      // Event doesn't touch an entitlement we track — acknowledge and ignore
      return res.json({ received: true, ignored: true });
    }

    let newValue = null;
    if (ACTIVATING_EVENTS.has(event.type)) newValue = true;
    else if (DEACTIVATING_EVENTS.has(event.type)) newValue = false;
    else {
      // Event type we don't act on (e.g. BILLING_ISSUE, TRANSFER) — just acknowledge
      return res.json({ received: true, ignored: true });
    }

    // Ensure the user row exists, then update the relevant column(s)
    await sql`INSERT INTO users (id) VALUES (${userId}) ON CONFLICT (id) DO NOTHING`;

    for (const column of affectedColumns) {
      if (column === "is_pro") {
        await sql`UPDATE users SET is_pro = ${newValue} WHERE id = ${userId}`;
      } else if (column === "is_family_pro") {
        await sql`UPDATE users SET is_family_pro = ${newValue} WHERE id = ${userId}`;
      }
    }

    console.log(`RevenueCat webhook: ${event.type} for ${userId} → ${affectedColumns.join(", ")} = ${newValue}`);
    res.json({ received: true });
  } catch (err) {
    console.error("RevenueCat webhook error:", err);
    res.status(500).json({ error: "Something went wrong." });
  }
});
// ── Start server (only used locally — Vercel handles this in prod) ─────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Lumie server running on http://localhost:${PORT}`);
});

module.exports = app;