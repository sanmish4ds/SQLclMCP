# SQLclMCP Web App

A simple single-page app that uses the SQLclMCP MCP server: type a question in plain English, get Oracle SQL.

## Run locally

1. Open `index.html` in a browser (double-click or `open app/index.html`).
2. Or serve it with a local server (avoids some file:// restrictions):
   ```bash
   cd app && npx --yes serve -p 3001
   ```
   Then open http://localhost:3001

## Deploy

- **GitHub Pages:** Push the repo, enable Pages, set source to branch and folder `/app` (or root and use `/app` as subpath).
- **Netlify / Vercel:** Drag the `app` folder or connect the repo and set publish directory to `app`.

The app calls `https://sqlclmcp.onrender.com` by default. To point at another MCP server, edit the `MCP_URL` constant in `index.html`.
