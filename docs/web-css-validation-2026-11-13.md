# U1：分域迁移与级联验证

从 main `ac9f802` 开始，先迁移控件与布局基础规则。`styles.css` 按原先位置导入 `ui/legacy-controls.css` 和 `ui/workspace-layout.css`；后续响应式与产品覆盖规则的位置保持不变。控件排除使用零特异性的 `:where()`，原生控件继续保留已有默认样式，Button、Input/Select/Textarea 焦点和字段标签由共享组件样式负责。规则归属见 [Web CSS ownership](web-css-ownership.md)。

这一步保留必要的原生控件与剩余业务规则，后续随组件迁移；没有将全仓样式一次性重写，也没有据此声称 CSS 加载变快。

## 浏览器测量

使用真实本地服务端和 Chromium，在 dark/light、1440/320px 下采集项目表单、标签、按钮、原生设置导航控件及原生能力复选框标签，共 25 组、550 个计算样式属性。原生导航可键盘激活，能力复选框可以选中，页面无横向溢出。

初次比较读到了主题与焦点过渡的中间帧，比较失败；原始 JSON 和 `.git/opt-u1-css-comparison.json` 保留。测量改为先解析样式，再等待元素实际动画结束。基线复测临时使用 HEAD 的两个样式文件，当前改动先以原始字节备份，finally 恢复并核对 SHA256；没有使用 reset/checkout 覆盖工作树。

稳定测量暴露了 `.ui-btn { box-shadow: none }` 对基础焦点环的覆盖。去掉旧 outline 后，这条规则会使按钮失去可见焦点；最终移除了该覆盖。中间证据 `.git/opt-u1-css-after-no-focus.json` 保留，最终样式比较为：

- 530 个属性保持一致。
- 20 个变化全部属于四种主题/宽度下的按钮焦点：从旧 outline 切换到 token 焦点环。
- 四种场景均确认实际 `boxShadow` 包含 2px 底色和 4px accent 环；抽样控件的尺寸、颜色、内边距及原生焦点表现无额外变化。

最终报告 `.git/opt-u1-css-final-comparison.json`，基线与最终数据 `.git/opt-u1-css-before-stable.json`、`.git/opt-u1-css-after-stable.json`；测量脚本和配置 `.git/opt-u1-css-probe.spec.ts`、`.git/opt-u1-playwright.config.ts`。稳定采样前后各 1 项通过、实际退出 0。320px 明暗主题最终截图已人工检查，焦点清晰可见；截图在 `.git/opt-u1-css-after-stable-results`。独立数据目录均由 `.git/opt-u1-*-directory.txt` 记录并保留。

## 回归

- 根 typecheck、最终 Web build 通过，实际退出 0：`.git/opt-u1-typecheck.log`、`.git/opt-u1-build-final.log`。
- 现有控件、反馈、导航、产品壳回归 4 文件、23 项通过：`.git/opt-u1-focused.log`。
- 首轮真实 Chromium 5 项通过，覆盖产品壳、成功反馈和连接队列：`.git/opt-u1-e2e.log`。焦点覆盖修复后，原有 feedback E2E 增加键盘焦点环必须可见的断言，最终 5 项再次全部通过、实际退出 0：`.git/opt-u1-e2e-final.log`。

本项的抽样样式测量与聚焦浏览器回归不替代最终统一 E2E、原生客户端或真实 Provider 产品验收。
