# MCP Interface v2 — W3-B 真实 Host A/B 证据契约

本目录与 issue #616、总跟踪 #598 对应。代码在 app/scripts/compact-host-ab-verify.mjs；负控单测在 app/test/compact-host-ab-verify.test.js。

**状态：W3-B1 证据校验器已经提交；真实 Host/Agent A/B 的 trial runner 与实测结果仍未交付。** 单元测试使用人工合成 Fixture，只证明 verifier 会拒绝不完整、篡改或越权证据。任何合成用例不得写成真实 Agent 成功率。

## 四个真实实验格

- full-eager：完整 legacy 工具列表直接交给 Host
- full-defer：完整 legacy 配置加 Host 原生按需发现
- compact-eager：Compact 工具列表直接交给 Host
- compact-defer：Compact 加 Host 原生按需发现

四格的用户任务、Vault 快照、模型、Host 版本、预期结果 Oracle、执行次数必须相同；操作员在服务启动时选择 profile，不能让提示词决定安全范围。宿主不支持 defer 时，manifest 中 deferSupported 为 false、对应 defer trials 统一标 unsupported，零调用、零 token、零时长，**不得伪造 defer 成功**。

## 报表结构与采集要求

每份 report.json 顶级只允许：schemaVersion、source、host、tasks、trials、repeats。

schemaVersion = 1.0.0。

source 仅允许 commitSha（40 位 Git SHA）、serverVersion、startedAt、fixtureManifestSha256。其中 fixtureManifestSha256 = sha256(UTF8(JSON.stringify(tasks)))，在跑实验前冻结。

host 仅允许 name、version、model、deferSupported。一个报表不能混合不同宿主或模型。

tasks 是 1–30 个任务，每个严格包括 id、promptSha256、fixtureSha256、expectedResultSha256。预期结果哈希应由确定性可检查的 Oracle 得出（例如隔离文件最终字节），不能仅凭 Agent 自述「完成」。

repeats 为 3–50。trials 必须覆盖每个 task × 四个 profile × 每个 repeat 索引，零遗漏、零重复。每条 trial 严格包含 taskId、cell、repeat、traceFile、traceSha256。traceFile 为报表所在目录内有界相对路径；SHA-256 针对原始 trace 文件字节计算。

每份 trace JSON **只允许**以下字段：taskId、cell、repeat、fixtureSha256、hostVersion、modelId、provenance、status、observedResultSha256、wallMs、inputTokens、outputTokens、descriptorTokens、unauthorizedCalls、unexpectedMutations、calls。provenance 固定 real-host，status 可取 ok、task_failed、host_error、unsupported。成功必须与 expectedResultSha256 所代表的独立 Oracle 哈希一致。非法动作调用或多余 mutation 一旦非零，整份证据 HOLD。

calls 最多 500 个，每个严格为 tool、action、ok、denied 四字段，**不得写入调用参数、凭据、全文输出、Prompt、隐含推理或敏感错误消息**。宿主原始 trace 应在另一受控位置留档供独立核对；本结构本身不能证明来源没有伪造。

## 验证命令

在 app 目录执行：

    node scripts/compact-host-ab-verify.mjs /path/to/report.json

校验器会对任务全集与源哈希、独立 trace 的哈希、路径和 symlink 逃逸、全部 trial 分母、状态/Oracle、权限泄漏做 fail-closed 检查。失败为 HOLD + 非零退出；成功仅返回 EVIDENCE_VALID_PENDING_W3_GO，**并非 W3/W4 通过证明**。

W3-B2 尚需真正执行 Pi 或其他 Host、注册完整 Trial，记录预先冻结的模型与成本/延迟门禁，独立核验 Oracle 并比较原始成功率。与 W3-A（#614）和 W3-C（#618）分离，互不复用虚假的实验样本。