export const FALLBACK_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Verox</title>
<style>
  body { background: #0f1117; color: #e2e8f0; font-family: system-ui, sans-serif;
         display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .box { text-align: center; }
  code { background: #1a1d27; padding: 4px 10px; border-radius: 6px; font-size: 13px; }
</style>
</head>
<body>
<div class="box">
  <h2>Verox Web UI</h2>
  <p>The Angular UI has not been built yet.</p>
  <p>Run: <code>pnpm run build:ui</code></p>
</div>
</body>
</html>`;

export   const VAULT_KEY = "config.channels.webchat.uiToken";