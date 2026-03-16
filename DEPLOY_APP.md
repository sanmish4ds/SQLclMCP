# Make the SQLclMCP UI available to anyone

**Simplest: Netlify (free, ~2 minutes)**

1. Go to **[netlify.com](https://www.netlify.com)** and sign in (e.g. with GitHub).
2. Click **Add new site** → **Import an existing project**.
3. Choose **GitHub** and authorize; select your **SQLclMCP** repo.
4. Set:
   - **Branch:** `main` (or your default)
   - **Base directory:** leave empty
   - **Build command:** leave empty
   - **Publish directory:** `app`
5. Click **Deploy site**.

You get a URL like `https://something-random-123.netlify.app`. Share that link — anyone can open it and use the UI. You can change the name in **Site settings** → **Domain management** (e.g. `sqlclmcp-ui.netlify.app`).

---

**Alternative: GitHub Pages (free)**

The repo already has `docs/index.html` (same as the app). So:

1. Commit and push (including `docs/index.html`).
2. On GitHub: **Settings** → **Pages** → **Source:** Deploy from branch → branch **main**, folder **/docs** → Save.
3. The site will be at: `https://<your-username>.github.io/SQLclMCP/`

---

**Summary**

| Method        | URL example                          | Best for              |
|---------------|--------------------------------------|------------------------|
| **Netlify**   | `https://your-site.netlify.app`      | Easiest, custom name   |
| **GitHub Pages** | `https://user.github.io/SQLclMCP/` | Already on GitHub      |

The UI calls your MCP server at `https://sqlclmcp.onrender.com`; no extra config needed.
