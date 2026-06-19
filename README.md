# Lumie Backend

Express proxy server that sits between your React Native app and the Anthropic API, keeping your API key safe on the server.

---

## Files

```
lumie-backend/
├── api/
│   └── index.js       ← the server (all your logic lives here)
├── .env.example       ← copy this to .env for local development
├── .gitignore         ← keeps secrets & node_modules off GitHub
├── package.json       ← project dependencies
├── vercel.json        ← tells Vercel how to deploy
└── README.md
```

---

## Step 1 — Install dependencies

Open Terminal, navigate to this folder, and run:

```bash
cd lumie-backend
npm install
```

---

## Step 2 — Add your API key locally

```bash
cp .env.example .env
```

Open `.env` and replace `your_anthropic_api_key_here` with your real Anthropic API key.

---

## Step 3 — Run locally to test

```bash
npm run dev
```

Visit http://localhost:3000 — you should see:
```json
{ "status": "ok", "message": "Lumie API is running 🌙" }
```

Test the chat endpoint with curl:
```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "I feel anxious today"}]}'
```

---

## Step 4 — Push to GitHub

```bash
git init
git add .
git commit -m "Initial Lumie backend"
```

Then create a new repository on github.com and follow the instructions GitHub shows you to push.

---

## Step 5 — Deploy to Vercel

1. Go to vercel.com and click **Add New Project**
2. Import your GitHub repository
3. In the **Environment Variables** section, add:
   - Key: `ANTHROPIC_API_KEY`
   - Value: your real API key
4. Click **Deploy**

Vercel will give you a URL like `https://lumie-backend.vercel.app`. That's your live API!

---

## API Reference

### GET /
Health check. Returns `{ "status": "ok" }`.

### POST /api/chat
Send a conversation and get Lumie's reply.

**Request body:**
```json
{
  "messages": [
    { "role": "user", "content": "I've been feeling really stressed lately" }
  ]
}
```

**Response:**
```json
{
  "reply": "I hear you — stress can feel really overwhelming..."
}
```

Messages should be in chronological order. Include the full conversation history each time so Lumie remembers the context.
