# iOS 通知直接解码

P7 从 main `1e3ce41` 开始。`ApiClientProtocol.notificationPage(before:limit:)` 返回 `NativeNotificationPage`，live client 沿用原同源请求、认证、会话失效和错误处理，在网络边界直接解码响应；不再先转为 JSONValue、重新编码 Data、再解码分页对象。共享分页类型移到 Models，避免 networking 引用 view-model 文件定义的契约。

全局未读徽标使用 limit=1，通知列表保持 limit=50、原 before 游标编码、加载窗口合并、读状态及全收件箱 unread_count。两处重复转换都已移除，保留扩展通知记录为 JSONValue、未知/失败与已测量零的区别，以及旧 session 返回结果隔离。协议默认实现显式报告预览夹具不支持，不能制造空列表或零计数；真实客户端覆盖该方法。

新增 XCTest 针对类型化请求检查认证、特殊字符游标、Unicode/扩展字段、分页元数据和无效计数的解码失败。保留现有分页窗口、跨设备 read 和未知/失败/零徽标测试。没有以源码变化声称测得 CPU 或内存收益。

Windows 静态契约检查通过：22 个请求样本、53 个端点及通知分页 domain 夹具（`.git/opt-p7-contracts.log`）。Node 22.23.4 的现有 parser 对本项 5 个修改文件解析无诊断（`.git/opt-p7-modified-swift-syntax.log`）。

全仓语法检查仍失败：`TaskDetailView.swift:643` 和 `AssistantConversationUITests.swift:1` 两处诊断。归档原始 main `1e3ce41`、使用相同 parser 复核得到完全相同的两处诊断；这两个文件在本项无修改。完整日志 `.git/opt-p7-swift-syntax-existing.log`、`.git/opt-p7-baseline-swift-syntax.log`，基线源码在 `.git/opt-p7-baseline`。不修改或忽略这两个诊断来报告全仓通过；其 Swift 编译有效性仍需 Xcode 证明。默认旧 parser 目录不完整的首次失败日志也保留为 `.git/opt-p7-swift-syntax.log`。

此环境没有 Xcode；新增/既有 XCTest 和 iOS 原生验收尚未在该提交执行，须由 macOS gate 补齐。以上契约和局部语法检查不等于 Swift 类型检查或产品 E2E。
