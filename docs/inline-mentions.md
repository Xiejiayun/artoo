# 内联成员提及

频道、任务/Goal 对话和线程回复中的讨论输入框，在光标前输入 `@` 和成员名字片段时显示最多八位匹配成员。候选来自当前已有的已授权成员列表，不增加成员查询或客户端授权判断；邮箱中的 `@` 不触发补全。可输入更多文字缩小范围，也可继续使用保留的 “Notify people” 复选框。

上下方向键选择、Enter 插入名字并同步通知对象，Escape 关闭建议。选择候选的 Enter 不发送消息；下一次普通 Enter 沿用原有发送行为。Shift+Enter、中文输入法提交与按住 Enter 的保护保留。候选通过 listbox/option 和输入框 aria-activedescendant 关联，焦点留在输入框；点击选择同样不会先把焦点移走。同名成员附上已有成员 ID 以便区分。

在光标处替换触发词，保留前后文字和标点。插入前检查现有消息长度上限，超长时保留原文并提示。所选成员 ID 去重后并入既有 `mentionIds`，正文和通知对象随原有 room/thread 草稿保存。通知对象仍是显式选择：修改正文不会暗中选择或取消收件人，可用保留的复选框查看/调整。Agent 执行模式不显示成员补全。

发送、断线未确认重试及服务端成员校验继续走原路径；补全不会替换请求身份或在未确认发送期间修改收件人。

## 验证

根 `npm run typecheck`、Web build 通过。完整 Web Vitest 66 文件、625 项通过；最后键盘提示调整后的补全和既有对话聚焦回归 2 文件、34 项通过。覆盖键盘、光标/标点、同名成员、IME、长度限制、草稿恢复和未确认重试。

最终 Chromium 聚焦回归 3 项通过，覆盖内联提及、既有大字体重排、短屏历史与多行发送。补全使用真实成员、真实频道和真实消息 POST，验证选择不会提前发送、真实收件人 ID、正文、焦点和复选框状态；暗色 1440/320px、浅色 320px 无横向溢出，鼠标候选未被遮挡。先前明暗截图已经检查。该受控本地浏览器检查不替代最终统一 E2E 或真实 Provider 验收。

日志保存在 `.git/opt-x4-web-tests.log`、`.git/opt-x4-hint-tests.log`、`.git/opt-x4-typecheck-reviewed.log`、`.git/opt-x4-build-reviewed.log`、`.git/opt-x4-regression-e2e.log`。最终浏览器证据目录为 `apps/web/test-results/workflows-2026-11-13T16-13-13-672Z`，独立数据目录见 `.git/opt-x4-regression-directory.txt`；早期浏览器日志及证据目录保留。
