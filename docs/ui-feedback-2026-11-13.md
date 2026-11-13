# U2：统一成功反馈

在应用级挂载 `ToastProvider`，项目保存、任务创建、配对命令复制、审批记录、计划接受/拒绝、证据导出和实例启停均在实际请求成功后提示。下载提示明确为“开始下载”，实例启停明确只影响后续分配；提示不包含配对凭据。失败仍由原有错误界面呈现，待发队列不提前显示成功。

项目保存原有 `role=status` 文本由 Toast 承担，避免重复播报。Toast 容器不再嵌套 `aria-live`，每条提示保留自身的 status/alert 语义；新增提示不重置已有提示的自动关闭期限。提示层高于对话框，并限制在窄屏视口以内。对话框关闭按钮复用 Tooltip，保留可访问名称、键盘关闭和焦点恢复。

连接反馈继续由 ConnectionStatus 承担，U3 单独优化健康态；加载占位留到 U4 按页面布局处理。

## 验证

- 完整 Web 单元/组件回归 61 文件、599 项通过，实际退出 0；日志及 JSON 为 `.git/opt-u2-web-all.log`、`.git/opt-u2-web-all.json`。

- 根 typecheck、Web build 通过，日志 `.git/opt-u2-typecheck.log`、`.git/opt-u2-build-final.log`。
- 初次聚焦回归共 75 项，74 通过；新增计时器测试因夹具重新挂载第一条提示而失败。修正稳定 key 后，feedback 文件 8 项通过，未放宽原始关闭期限和提示数量断言。初次失败及复核日志均保留。
- 真实 Chromium E2E 1 项通过、实际退出 0：创建任务、不抢焦点、真实证据下载与内容核对、项目保存单次播报、1440/320px 边界及键盘关闭提示。日志 `.git/opt-u2-e2e.log`。
- 1440/320px 截图已人工检查：`apps/web/test-results/workflows-2026-11-13T14-51-51-404Z`。独立 E2E 数据目录保留于 `.git/opt-u2-e2e-directory.txt` 指向的位置。

以上为本项验证，不替代全部优化后的集成门禁及真实 Provider 产品验收。
