/**
 * dsh-lan-web — /m mobile surface routes (Host half).
 *
 *   GET /m        → app shell (LAN without a valid login session gets a
 *                   self-contained login shell instead; loopback exempt)
 *   GET /m/app.js → the standalone mobile bundle (lib/mobile.js), same gate
 *
 * The login gate is dual-layer here too: the route itself refuses the app
 * shell to unauthenticated LAN clients (server side), and the app JS also
 * probes /api/lan-web/status as a client-side backstop (kicked / expired
 * sessions while browsing). Data calls go straight to DSH's /api/* (the
 * trust fence covers the LAN; see README boundary note).
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { LanWebStore } from './store.ts'
import { COOKIE_NAME, isLoopback, readCookie } from './routes.ts'

const VIEWPORT_META =
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />'

const APP_SHELL = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
${VIEWPORT_META}
<meta name="theme-color" content="#0f1115" />
<title>DSH 移动端</title>
<style>html,body{margin:0;height:100%;background:#0f1115;color:#e6e6e6;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-text-size-adjust:100%}</style>
</head>
<body>
<div id="root"></div>
<script type="module" src="/m/app.js"></script>
</body>
</html>`

/** Self-contained login shell (no app bundle): JSON POST to the login gate. */
const LOGIN_SHELL = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
${VIEWPORT_META}
<meta name="theme-color" content="#0f1115" />
<title>登录 · DSH</title>
<style>
  html,body{margin:0;height:100%;background:#0f1115;color:#e6e6e6;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-text-size-adjust:100%}
  body{display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
  .card{width:100%;max-width:360px;padding:32px 28px;border-radius:14px;background:#1a1d24;box-sizing:border-box}
  h1{margin:0 0 6px;font-size:20px;font-weight:600}
  p{margin:0 0 22px;font-size:13px;color:#9aa0ab}
  label{display:block;font-size:13px;color:#c3c7cf;margin-bottom:8px}
  input{width:100%;min-height:44px;padding:0 14px;font-size:16px;border-radius:8px;border:1px solid #333a45;background:#12151b;color:#e6e6e6;box-sizing:border-box;outline:none}
  button{width:100%;min-height:44px;margin-top:18px;font-size:16px;font-weight:600;border-radius:8px;border:none;background:#3b82f6;color:#fff}
  .err{margin-top:12px;font-size:13px;color:#f87171;display:none}
</style>
</head>
<body>
<div class="card">
  <h1>DeepSeek Harness</h1>
  <p>局域网访问需要登录</p>
  <label for="pw">密码</label>
  <input id="pw" type="password" autocomplete="current-password" enterkeyhint="go" />
  <button id="go">登录</button>
  <p class="err" id="err"></p>
</div>
<script>
(function () {
  var pw = document.getElementById('pw');
  var go = document.getElementById('go');
  var err = document.getElementById('err');
  function submit() {
    go.disabled = true;
    err.style.display = 'none';
    fetch('/api/lan-web/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: pw.value }),
    }).then(function (res) {
      if (res.status === 200) { location.href = '/m'; return; }
      if (res.status === 429) { err.textContent = '尝试次数过多，请稍后再试'; }
      else if (res.status === 403) { err.textContent = '管理员尚未配置密码，局域网访问暂不可用'; }
      else if (res.status === 401) { err.textContent = '密码错误'; }
      else { err.textContent = '登录失败（' + res.status + '）'; }
      err.style.display = 'block';
      go.disabled = false;
      pw.focus();
    }).catch(function () {
      err.textContent = '网络错误，请重试';
      err.style.display = 'block';
      go.disabled = false;
    });
  }
  go.addEventListener('click', submit);
  pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
  pw.focus();
})();
</script>
</body>
</html>`

export function registerMobileRoutes(ctx: Context, store: LanWebStore): void {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/m', handler: (req, res) => void handlePage(req, res, store) }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/m/app.js', handler: (req, res) => void handleBundle(req, res, store) }))
}

/** True when the request may see the app (loopback exempt, or valid cookie). */
function authed(req: IncomingMessage, store: LanWebStore): boolean {
  if (isLoopback(req)) return true
  const token = readCookie(req, COOKIE_NAME)
  return token !== undefined && store.validate(token) !== null
}

function writeHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
  })
  res.end(html)
}

async function handlePage(req: IncomingMessage, res: ServerResponse, store: LanWebStore): Promise<void> {
  if (req.method !== 'GET') {
    writeHtml(res, 405, '<h1>405</h1>')
    return
  }
  writeHtml(res, 200, authed(req, store) ? APP_SHELL : LOGIN_SHELL)
}

let bundleCache: { etag: string; code: Buffer } | null = null

async function handleBundle(req: IncomingMessage, res: ServerResponse, store: LanWebStore): Promise<void> {
  if (req.method !== 'GET') {
    res.writeHead(405).end()
    return
  }
  if (!authed(req, store)) {
    res.writeHead(401).end()
    return
  }
  try {
    if (bundleCache === null) {
      // Built: lib/index.js → ./mobile.js. Dev/tests (src/): fall back to ../lib.
      const candidates = [new URL('./mobile.js', import.meta.url), new URL('../lib/mobile.js', import.meta.url)]
      let code: Buffer | undefined
      for (const url of candidates) {
        try {
          code = await readFile(fileURLToPath(url))
          break
        } catch {
          /* try next */
        }
      }
      if (code === undefined) throw new Error('lib/mobile.js not found (run npm run build)')
      bundleCache = { etag: `"${code.length}-${Date.now()}"`, code }
    }
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'content-length': bundleCache.code.length,
      'cache-control': 'no-store',
      etag: bundleCache.etag,
    })
    res.end(bundleCache.code)
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`mobile bundle unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
}
