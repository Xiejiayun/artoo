# U3：健康连接态与命令重放

只有浏览器在线、实时连接 connected、无待发命令且未使用 prepared polling 时，连接状态才收拢为 Header 绿点。指示器可以键盘聚焦，名称与 Tooltip 均为 Live updates connected；Tooltip 朝页面内展开。离线、重连、鉴权失败、轮询模式及待发队列继续使用原有 `role=status` / `aria-label="Connection status"` 横幅与重试按钮。

AppRoutes 只运行一次连接 hook，两个展示组件共用其状态。保留 pending 的 beforeunload 保护、connected 时重放及 polling 模式每 5 秒重放；未增加普通实时会话的定时重放。轮询 hook 订阅模式布尔值，避免无关 bootstrap 对象更新在子组件渲染期间触发父壳更新。

真实浏览器流程发现 StrictMode 的额外清理会移除在队列构造时注册的 online 监听器，而后续 effect setup 没有重新注册。Provider 现在在 effect 中注册和移除该监听器，队列构造没有浏览器副作用。卸载仍取消未发命令，不能将旧会话命令带入新身份。

## 验证与失败记录

- 最终根 typecheck、Web build 通过，实际退出 0；日志 `.git/opt-u3-queue-typecheck.log`、`.git/opt-u3-queue-build.log`。
- 完整 Web 单元/组件回归 63 文件、604 项通过，实际退出 0；日志/JSON 为 `.git/opt-u3-web-all.log`、`.git/opt-u3-web-all.json`。
- 初轮 5 文件 22 项中 21 通过，Skills 懒加载测试在原 1 秒查找期限内未等到模块；单 worker 及单文件复核同样失败。未调整查找或测试总时限、未 mock 页面、未删除断言。测试现在显式等待 Vitest 的真实动态模块转换完成再核对原有路由与契约；修正后 22 项通过，渲染警告消失。
- 新增 Provider 回归先红后绿：旧实现普通模式通过、StrictMode 失败（online 后回调 0 次），日志 `.git/opt-u3-strict-before.log`。修复后含连接、路由、Provider、prepared polling 和规范队列的 6 文件 24 项通过，实际退出 0，日志 `.git/opt-u3-queue-final.log`。
- 首次浏览器测试发现全局 status 内边距将指示器撑至 48px，修正组件 padding 后保留原尺寸断言。第二次暴露上述 StrictMode 自动重放问题，失败证据均保留。
- 最终真实 Chromium E2E 1 项通过、实际退出 0，日志 `.git/opt-u3-e2e-final.log`：1440/320px 指示器、焦点和 Tooltip、在线期间的受控请求失败、离线横幅和队列、恢复后真实任务 ready、各次请求使用同一非空幂等键。受控网络失败只用于故障注入，最终写入为真实服务端请求。
- 已检查 1440/320px 健康态及 320px 离线待发截图，文字/焦点可见、无横向溢出。失败与最终运行各自使用独立数据目录，均保留 `.git/opt-u3-e2e*-directory.txt` 指向的目录。
- 最终浏览器证据目录：`apps/web/test-results/workflows-2026-11-13T15-07-32-779Z`。

以上不替代最终统一集成验收或真实 Provider 产品验收。
