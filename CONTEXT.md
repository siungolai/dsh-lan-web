# CONTEXT — dsh-lan-web 领域词汇表

> 术语随设计推进即时更新。仅收录已敲定的概念，不含实现细节。

## 已敲定术语

| 术语 | 定义 | 备注 |
|------|------|------|
| **登录门**（login gate） | 局域网设备访问 DSH Web GUI 前必须通过的密码认证关卡；本机 loopback 豁免 | 双执行层：Client 全屏遮罩 + Host 路由校验 |
| **登录会话**（auth session） | 登录成功后签发的会话记录（cookie token、设备、滑动续期、纪元），持久化于 `~/.dsh/dsh-lan-web.json` | 与「对话会话」严格区分 |
| **对话会话**（conversation） | DSH 的聊天会话（会话列表里的每一项），非登录会话 | 移动面上用户看到的是它 |
| **滑动续期**（sliding renewal） | 每次受保护请求刷新登录会话有效期，30 天无活跃才退出 | |
| **会话纪元**（epoch） | 改密码 +1 并清空全部登录会话，防旧 cookie 重放 | |
| **fail-closed** | 未配置密码时拒绝一切 LAN 登录，不得放行 | |
| **移动面**（mobile surface） | 面向手机的独立移动专用页面（`/m`），与桌面 GUI 解耦、自有布局与交互 | 2026-08-16 敲定提前实施；区别于响应式适配 |
| **响应式适配**（responsive adaptation） | 给桌面 GUI 加窄屏断点——**已否决**（F6：官方 GUI 无响应式断点，侵入式改造维护成本高） | |
| **核心闭环**（core loop） | 移动面一期范围：会话列表 → 打开历史 → 发消息 → 看回复 | 手机 95% 使用场景 |
| **设备**（device） | 一台已登录的设备记录（deviceId、UA、最后活跃），可单独踢出 | |

## 移动面子词汇（2026-08-16 定稿）

| 术语 | 定义 |
|------|------|
| **移动面鉴权** | `/m` 与桌面 GUI 共用同一登录门：LAN 无有效登录会话 → 内联登录页；loopback 豁免；登录后同一 cookie 通行 |
| **移动交互规范** | 会话列表=标题+最后活跃时间倒序全量；回复=流式（SSE，与桌面一致）；历史=分页（最近 50 条 + 向上加载更多） |
| **验收节奏** | 先浏览器移动视口（390×844）自测闭环，再真机（192.168.31.97）确认一轮 |
| **注入样式定位** | 保留但收窄：仅服务登录遮罩与设置卡；不试图修复桌面 GUI 的移动布局 |
| **原型优先** | 先出「丑但能用」的最小闭环验证手机可用性，再补工程化 |

## 协议层术语（2026-08-16 事实定稿）

| 术语 | 定义 |
|------|------|
| **协议信封** | DSH 后端通信格式：REST 外形 JSON-RPC（上行 `POST /api/<method>`，`{type:"client-request", rpcId, method, payload}`；响应 `{type:"server-response", rpcId, result:{ok,value\|error}}`） |
| **事件通道** | 浏览器端下行事件走 WebSocket `/api/events.mux`（`session/subscribed` 基线 + `session/event` 帧：chunk 增量 / message 定型 / turn/end）；Node 进程内才是 SSE |
| **信任围栏**（trust fence） | DSH 传输层防线：Host 必须 loopback 或 trustedHosts + 非 cross-site + Origin 同源；注释明言 "not an auth layer"。绑定 0.0.0.0 时本机 LAN IP 自动入 trustedHosts |
| **移动数据平面** | 移动面调用的数据/命令接口集合（session.list/history/prompt/create + 事件流）。待定：直连 `/api/*`（与桌面同等边界）vs 插件代理 `/api/lan-web/m/*`（登录门覆盖） |

| **移动面信息架构** | 两级切换：列表页 ⇄ 会话页（返回键回列表），无底部导航 |
| **移动面视觉** | 深色主题，与登录遮罩（#0f1115 底）一致 |

## 升级路径事实（2026-08-16 核查，原型后启用）

- **进程内代理完全可行**：`sessions` 服务（dsh-session 注册）可注入；`session/event` 是进程内 cordis 事件（WS 桥只是其消费者），插件可 `ctx.on("session/event")` 订阅；`webServer.registerUpgrade` 可注册自建 WS 端点
- 创建/驱动会话必须走 `ctx.agents`（`sessions.create`/`append` 不会启动 agent 循环）；冷会话事件需 `sessionQuery`/`sessionPersistence` 读取
- 移动面原型（Q5b-A）：页面直连 `/api/*`（信任围栏覆盖 LAN，边界同桌面 GUI）
