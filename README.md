# dsh-lan-web

**Secure LAN & mobile access for DeepSeek Harness with a login gate.**
**带登录鉴权的 DeepSeek Harness 局域网 / 手机访问插件。**

A DSH plugin that exposes the DSH Web GUI to your home/office LAN with password-based authentication, persistent sessions, and a mobile-friendly experience.

一个把 DSH Web GUI 安全带到家庭/办公局域网的 DSH 插件：密码登录、会话持久化、手机友好。

> ⚠️ **Security note / 安全提示**: Binding to the LAN exposes your Harness (including command execution) to every device on the network. This plugin adds a login gate, but you must understand the trust boundary — see [Security Model](#security-model--安全模型).
> 绑定局域网后，同网段任意设备都可触达你的 Harness（含命令执行）。本插件提供登录门，但你必须理解信任边界——见[安全模型](#security-model--安全模型)。

---

## Features / 特性

| 能力 | 说明 |
|------|------|
| LAN binding / 局域网绑定 | Bind `0.0.0.0` via bundle patch; official `--host 0.0.0.0` is intentionally rejected by DSH. 经 bundle patch 绑定 `0.0.0.0`（DSH 官方拒绝该 CLI 参数） |
| Login gate / 登录门 | Password-based login for LAN devices; loopback exempt. 局域网设备必须密码登录，本机豁免 |
| Persistent sessions / 会话持久化 | 30-day remember-me, multi-device, change-password-kicks-all, survives restarts. 30 天免登录、多设备并行、改密码全踢、重启不丢 |
| Device management / 设备管理 | View & revoke logged-in devices from the settings card. 设置页查看/踢出已登录设备 |
| Mobile friendly / 手机友好 | Responsive layout, touch-friendly targets. 响应式布局、触摸友好 |
| **Mobile surface / 移动面** | Standalone phone UI at `/lan` — chat core loop, `/` skill menu, tool/reasoning/approval cards; phones hitting the main address auto-redirect (desktop untouched). 手机专用移动面 `/lan`：核心聊天闭环、`/` 技能菜单、工具/思考/审批卡片；手机访问主地址自动跳转（桌面不受影响） |
| HTTPS-ready / 预留 HTTPS | Config schema reserves HTTPS fields (not yet implemented). 配置位预留 HTTPS（未实现） |

## Install / 安装

Requirements / 要求：DSH `>= 0.1.0-rc.6`，Node `^22.19.0 || >=24.0.0`。

```bash
# 1. Clone（或直接使用本仓库路径做 link 安装）
git clone https://github.com/siungolai/dsh-lan-web.git

# 2. Build the plugin package
cd dsh-lan-web
npm install && npm run build

# 3. Register into your web profile (dev-style link install)
dsh plugin --profile web add link:$(pwd)

# 4. Restart DSH web
dsh web
```

> **Note / 说明**: patch order matters — a `webserver` row override is applied in bundle order, with the last write winning (whole-config replacement). If another plugin in your profile also overrides the `webserver` row, only one binding config takes effect.
> 注意 patch 顺序：`webserver` 行覆盖按 bundle 顺序应用，后加载者生效（整行替换）。若 profile 中另有插件覆盖该行，只有一个绑定配置生效。

## Configuration / 配置

Settings namespace `dsh-lan-web` in `~/.dsh/settings.yaml`:

```yaml
dsh-lan-web:
  sessionDays: 30     # 会话滑动有效期：无活跃登录多少天后退出
  # httpsCert: ''     # 预留：HTTPS 证书路径（未实现）
  # httpsKey: ''      # 预留：HTTPS 私钥路径（未实现）
```

**Password / 密码**：set via the settings card or `POST /api/lan-web/password`（first login must be configured by an admin on the host machine — until then LAN login is refused, fail-closed). The password is stored as a **scrypt hash** in the plugin's private data file (`~/.dsh/dsh-lan-web.json`, mode 0600), never in `settings.yaml`.
密码经设置卡或 `POST /api/lan-web/password` 设置（首次须在本机配置，未配置前局域网登录一律拒绝，fail-closed）。密码以 **scrypt 哈希** 存于插件私有数据文件（`~/.dsh/dsh-lan-web.json`，权限 0600），绝不写入 `settings.yaml`。

## Security Model / 安全模型

| Source / 来源 | Trust fence / 信任围栏 | Login gate / 登录门 |
|---------------|------------------------|---------------------|
| Localhost（本机） | allowed | exempt / 豁免 |
| LAN device（局域网设备） | allowed (trustedHosts) | **required / 必须登录** |
| Unknown host（其他来源） | 403 | — |

**Trust boundary / 信任边界**：

- 一期为明文 HTTP：同网段设备理论上可嗅探流量（含你的 DSH 会话内容）。仅限家庭/办公可信网络；公共 WiFi 请勿开启。敏感网络建议叠加 Tailscale 等加密隧道。
- **Login gate boundary / 登录门边界（必读）**：The login gate is a **two-layer UX + route gate, not a transport-layer interception** — a full-screen login mask in the browser plus route checks on the plugin's own `/api/lan-web/*` endpoints. It does **NOT** block DSH's real APIs: an unauthenticated LAN device can still fetch the GUI static assets and call any `/api` endpoint the platform trust fence permits (including command execution). 登录门是「浏览器全屏遮罩 + 插件自有入口校验」双执行层，**不是传输层拦截**：未登录的局域网设备仍可触达 GUI 静态资源与信任围栏放行的 DSH `/api` 接口（含命令执行）。仅在可信局域网启用本插件，不可信网络请叠加加密隧道（如 Tailscale）。
- DSH 传输层信任围栏（loopback/trustedHosts 校验）仍生效：核心 `/api/*` 对未知 Host 一律 403；插件自有入口（`/api/lan-web/*`、`/lan`）对未知 Host 一律 401（登录门，与围栏独立生效）；静态页面可达但本身不含数据（数据全在 `/api`）。
- 未设置密码时 LAN 访问默认拒绝（fail-closed）。
- 改密码会立即使所有已登录设备失效。

## Mobile Surface / 移动面

Mobile devices get a dedicated surface: `http://<LAN-IP>:3080/lan` — a self-contained page (loads **no** desktop UI plugins) with:

- **核心闭环**：会话列表（标题+时间倒序）、历史（分页 50 条+加载更多）、流式回复、新建会话
- **`/` 技能菜单**：与桌面一致——输入 `/` 弹出技能列表（`/name` + 描述，非模型可调用标「仅用户 ·」），选中插入 `/<skill-name> ` 后回车发送，宿主钩子注入 skill 内容
- **动作卡片**：🧠 思考（折叠）、🔧 工具调用、工具结果、⏳ 等待审批、❓ 等待回答、📋 任务清单——与桌面视觉可对应
- **自动跳转**：手机 UA 访问主地址 `/` 时在插件加载前同步跳转 `/lan`（桌面 UA 不受影响；`?desktop=1` 或 `dsh_lan_web_ui=desktop` cookie 可退出，移动面内「桌面版 ›」链接设置之）
- **登录**：与桌面共用同一登录门（路由级 + 客户端兜底；loopback 豁免）

手机访问 `http://<LAN-IP>:3080/lan` 即可使用；或直接访问主地址由 UA 检测自动跳转。

## Development / 开发

See [PLAN.md](./PLAN.md) for architecture, milestones, and acceptance criteria.

```bash
npm run typecheck   # type check
npm run build       # tsc + tsdown → lib/
npm test            # vitest unit tests
```

## License / 许可证

[MIT](./LICENSE) © siungolai
