# U4：统一首次加载占位

## 行为

- `LoadingView` 复用既有 `Skeleton` / `SkeletonText`。每个加载区域只有一个 `role="status"`，保留原加载文案；装饰部分 `aria-hidden` 且 `inert`，没有假按钮、输入框或证据状态。
- Plan 的初始目标列表与详情、Release 的目标与检查卡片沿用实际布局 class 和响应式断点。Plan 只有确认空结果后才自动展开创建区，避免把尚未返回的列表当成空项目。
- Plans、checkpoints、Agent history 列表与详情、Settings 项目与设备分别加载。失败、重试、空结果与分页保留原有路径。
- 骨架仅用于首次加载；不使用 `isFetching` 替换后台刷新中的缓存内容。Release 在尚未获得发布响应时显示占位，避免提前显示“Not published”或检查结论；错误仍显示并可重试。
- 路由首次打开的 Suspense 使用通用页面骨架。React 导航 transition 可保留当前页面直到新模块就绪，沿用框架行为。
- 局部 status 规则排除旧全局 padding 的干扰；骨架动画继续遵循既有 reduced-motion 设置。

## 验证范围

组件回归覆盖首次加载到成功、空结果、失败重试，独立区域结算，以及目标后台刷新保留内容。浏览器测试延迟真实本地服务端或 Vite 响应，没有合成成功 API 数据；检查明暗主题、320/1440px、reduced motion、左右栏位置与宽度、无横向溢出，以及真实证据返回前后状态。

这些检查验证加载行为与横向布局，不是 CLS 基线/收益测量，也不是 live Provider 或生产发布验收。最终全仓门禁和统一 E2E 在其余优化合并后执行。

## 执行结果

- 根 `npm run typecheck` 与 Web build 通过，最终实际退出码均为 0。
- 完整 Web Vitest：64 文件、610 项通过，实际退出码 0，无未处理错误。日志 `.git/opt-u4-web-tests.log`。
- 真实 Chromium：三项通过，实际退出码 0；Plan 明暗主题 × 320/1440px 的左右栏 x/width 前后差异均小于 1px，检查 reduced motion、装饰占位不可操作和无横向溢出。Release 等待真实发布响应，Settings 首次路由及独立设备加载通过。日志 `.git/opt-u4-e2e-final.log`；证据 `apps/web/test-results/workflows-2026-11-13T15-41-17-090Z`。Plan 320px 明色与 1440px 暗色截图已查看。
- 设备区补充可见性检查：滚动到 320px 的真实 Devices 加载区域后截图，独立一项复验通过、退出码 0，截图已查看。日志 `.git/opt-u4-e2e-settings.log`；证据 `apps/web/test-results/workflows-2026-11-13T15-43-28-475Z`。
- 首轮新增组件夹具漏填 Run 状态，并在查询开始前触发拒绝；修正真实查询开始同步后，全量通过。浏览器夹具先后发现解除拦截过早、transition 保留旧页面，以及 Settings 不显示 Project views 导航的既有契约；修正拦截生命周期与正确的页面/导航预期，不修改产品导航、不增加超时。早期失败日志与截图保留在 `.git/opt-u4-*` 及各次浏览器证据目录。
