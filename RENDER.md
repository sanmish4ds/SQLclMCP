# Deploy MCP server on Render (free tier)

Get your MCP server live at a public HTTPS URL so others can call `/health` and `/generate-sql`.

## 1. Push to GitHub

Ensure this repo is on GitHub and includes:

- `mcp-server-http.js`
- `package.json`
- `experiments/test_questions.json` (used for lookup/hybrid mode)

Do **not** commit `.env` (it’s in `.gitignore`). You’ll set secrets in Render.

## 2. Create a Web Service on Render

1. Go to [render.com](https://render.com) and sign up (e.g. with GitHub).
2. **New +** → **Web Service**.
3. Connect the repository that contains this project.
4. Use:

   | Field | Value |
   |--------|--------|
   | **Name** | `sqlclmcp-mcp-server` (or any name) |
   | **Region** | Choose closest to you |
   | **Branch** | `main` |
   | **Runtime** | Node |
   | **Build Command** | `npm install` |
   | **Start Command** | `npm start` |
   | **Instance Type** | **Free** |

5. **Environment** → Add:

   | Key | Value | Required |
   |-----|--------|----------|
   | `ENABLE_LLM_SQL_GEN` | `true` | Yes |
   | `LLM_API_KEY` | your OpenAI (or compatible) API key | Yes (for LLM mode) |
   | `LLM_MODEL` | `gpt-4o-mini` | No (default) |
   | `LLM_API_URL` | e.g. `https://api.openai.com/v1/chat/completions` | No |
   | `DB_USER` | e.g. `mcp_dev` | No (only for /health display) |
   | `DB_PASSWORD` | … | No |
   | `DB_HOST` | your Oracle host | No |
   | `DB_PORT` | `1521` | No |
   | `DB_SID` | e.g. `FREE` | No |

   Render sets `PORT` automatically; the server uses it.

6. Click **Create Web Service** and wait for the first deploy.

## 3. Use the live URL

When the deploy succeeds, Render shows a URL like:

`https://sqlclmcp-mcp-server.onrender.com`

Test:

```bash
curl https://YOUR-SERVICE-NAME.onrender.com/health
```

Then point the evaluation runner at it:

```bash
export MCP_SERVER_URL=https://YOUR-SERVICE-NAME.onrender.com
cd experiments && python3 mcp_evaluation.py --run-mode compare
```

## Free tier limits

- Service sleeps after ~15 minutes of no traffic; first request after that may take ~30–60 s (cold start).
- 750 free instance hours/month; 512 MB RAM.
- No secrets in the repo; set all keys in Render **Environment**.

## Optional: custom domain

In Render: **Settings** → **Custom Domain** → add e.g. `api.yourdomain.com` and follow the DNS instructions.
