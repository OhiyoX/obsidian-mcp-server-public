# 身份/迁移方案冻结（R-B，执行方案锁定；契约 revision 待独立审查）

2026-10-10，起始 6e8eb21c。遵循 RULING-437-W2-REPAIR.md；此处锁定本轮实现方案，不表示席位批准新契约或解除 RETURN。

## 方案与 incarnation 判别

受管 identity v2 = canonical realpath + decimal dev/ino + 256-bit 随机 incarnation，规范 JSON tuple 后 SHA-256。incarnation 在可信管理员显式 initialize/approve 时，以 exclusive create 建立 Vault 根的 `.obsidian-mcp-incarnation.json`（marker schema v1），与 DATA_PATH 准入记录和 enrollment sentinel 中的 v2 identity 配对绑定。扫描/重启/消费操作只读取，绝不自动修补标记。标记不存在、损坏、symlink 或不匹配时保持不可用。

删掉整个目录会删掉标记；同路径同 dev/ino 重建也缺少原 incarnation，故旧批准失效。显式初始化仅能为没有可信旧绑定的 ID 创建标记；有旧绑定时必须读取并匹配，不能补标记并沿用授权。标记是持久身份凭证而非访问权限；复制原目录连同标记是恢复原目录的操作，需受信任的管理员/备份边界。不宣称防护任意有写权限者伪造/拷贝原凭证的敌对 writer。

## 迁移与兼容策略

identityVersion 升为 2；v1 解析保留用于保存旧绑定，不可在生产受管 gate 放行。准入记录/enrollment 外层 JSON schema 仍 v1（其 identity 字段已有格式版本），允许保留 v1 tombstone 与 v2 绑定；两文件照旧先 sentinel 后 record、revision/generation floor 单调。旧二进制不识别 identity v2，必须拒绝解析，不能回落 legacy。

既有 tuple-only v1 没有可验证的 incarnation 历史，不能靠现在相同 tuple 自动升级并承权。显式迁移采用新 ID：保留旧 ID 的可信 v1 绑定与数据，管理员确认新配置 ID，在新 ID 下显式 initialize/approve 创建 v2 绑定；原 allowedVaults/按 ID 数据不自动迁移。旧记录未初始化时，只能显式恢复相同的 v2 证明；无法恢复可信绑定的旧 ID 拒绝。数据复制、旧授权撤销及新 allowlist 配置由管理员独立确认，不是发现路径的副作用。

marker 创建先于 sentinel/record；跨文件不是事务。失败可能留下无授权 marker，重试同一新 ID可读取它；已绑定 ID 不允许补写。sentinel 先写、record 失败时维持 floor 和拒绝，显式恢复仍 max(record,sentinel)+1。回滚不得删除标记/绑定；候选撤回用新增 revert commit，生产降级须先隔离旧 ID/pending/撤销项。

## 冻结契约对应

- §2.3：正常启动不写 marker/不迁移；仅显式管理员确认清单建立身份与批准。
- §3.1：原绑定永不被替换目录覆盖；旧 ID 禁复用，v1 迁移也采用新 ID。
- §4：身份校验→prepare→sentinel/record→组合发布→激活/退役；身份失败先收紧拒绝，持久化失败不撤销。
- §5：消失保持原准入决定、运行不可用；恢复须 v2 identity 匹配；重命名/新 ID 不承接批准。
- §10：丢标记不可降级 tuple/路径放行；回滚/旧二进制须先证明隔离，不能自动切 legacy。

## 实现与验证（上一执行线程记录，未独立验收）

本节数值来自上一执行线程的落盘记录；本轮收口线程不将其算作自己的通过证据。本轮亲跑命令、原始汇总、失败与未证实项在 HANDOFF-W2-F1F5.md 的 R-A / R-B 修复节追加，且优先于本节历史状态。

R-A ccb8325e：owner 私有计划存储、opaque previous token；公开 next/released/条目无已提交 membership 别名；instancesOf 仅只读事实。原始 6e8eb21c 产品源上 previous.delete、previous.clear、instancesOf.delete 均复现 registry/record 仍含 alpha 而 map 缺项；修后同反例三面一致。原始红/绿日志与攻击逐项见 HANDOFF。

R-B 3b3f53e8，迁移/实际 worker 286eb4b9，startup barrier 52e20ea1。真实 ext4 同 dev/ino 删除重建、健康原目录独立进程重启、替换后重启、旧 ID 重批拒绝、旧句柄与实际 Git timer/direct sweep 均有基线红/修后绿；真实 primary Git/retrieval 接线另有集成负控。保留受控不同 inode 测试。最终探针 dev=2096/ino=821749 真实复用一次，旧句柄拒绝、替换 Git HEAD 不变、旧 durable binding 保留。

完整测试树 7f4e8be8b1f7cfea252388a3628c32c48a713c18（功能代码与 52e20ea1 相同）：Windows/原生 ext4 指定八文件各 91/91；return-fixes + incarnation-lifecycle + identity 各 21/21，全部 fail/cancelled/skipped/todo=0。check 831 syntax/952 architecture，inventory 10/10，Python 36/36，npm audit 0 漏洞。旧 6e8eb21c store 对实际 v2 record/sentinel 返回 VAULT_ADMISSIONS_CORRUPT 且两文件不变。

全量仍 FAILED：Windows CI runner 4058/4038pass/1fail/19skip（Git deadline）；原生 ext4 CI runner 与 npm test 均 4058/4054pass/1fail/3skip（Git migration 持久化配置读取 env-default）。完整 BASE ext4 4048/4044pass/同一失败/3skip；Windows BASE 有 audit 缺行/EBUSY，两项失败，没有证实 Git deadline 根因。原始汇总、skip 与早先失败均保留于 HANDOFF 与 logs/rarb-*.log。

当前契约回读 sha256:5240077f57b8dea1ac815b5c028f4797380ed7d495a9e7bf85f6020075895534，增补未批准；candidate/RETURN 不变。远端 Node22 CI、独立席位、W3新接口、#441 前置、NAS/生产仍未验收；本轮未 push/merge/release/deploy。

## 2026-10-10 本轮收口亲跑状态

本轮功能/测试快照与 7f4e8be8 相同：Windows 与原生 ext4 八文件各 91/91，return-fixes + incarnation + identity 各 21/21、四零；R-A 同测试旧树 3 pass/4 fail → 新树 7/7；真实 ext4 同 dev/ino 无注入 probe 旧红 → 新绿，旧批准无服务权、旧句柄不读替换内容，旧 timer/direct sweep 拒绝且替换 Git HEAD 不变，健康/替换跨进程重启对照通过。原 v1 store 对实际 v2 record/sentinel 拒绝且字节不变。

Windows 全量 CI adapter 4058 tests / 4039 pass / 0 fail / 19 skip，exit 0；Linux 全量 4058 / 4054 pass / 1 fail / 3 skip，exit 1；完整原始 6e8eb21c BASE 4048 / 4044 pass / 同一 fail / 3 skip。失败均为 git-migration-isolation.test.js:140，env-default ≠ persisted；根因仍未证实，Linux 全量仍 FAILED。check 831/952、root inventory 10/10、Python 36/36 亲跑通过。原始命令、汇总、初跑失败及 audit/未证实项见 HANDOFF 的「本轮收口」子节；该节优先于上方上一线程历史记录。candidate/RETURN 与独立席位、远端 CI、W3/#441、生产限制保持。

## R-C 恢复代次修复（2026-10-10，本地候选）

RULING-437-W2-RARB.md（绑定 72183d99）新增 P1：proof currency 吊销将消费 lease 1→2，恢复原 proof 后显式 approve 将 authority 1→2；数字相等却旧 lease 已 revoked，原 refresh 交回旧死 facade。此不改变 §3.2 原目录/proof 恢复或 §4.2 旧 facade 永久吊销契约。

instance-leases.refresh 仅对同 generation 且未 revoked 保持幂等；对已提交允许、真实 identity/proof 有效、digest 保持且 authority 不回退的当前批准建立新 lease/facade。旧对象不解除 revoked；null/旧 authority/refusal/missing/changed proof 不 mint。primary publish 的 onPrimaryLease 同步获得新对象，后台消费者依旧按固定 lease/token 拒绝旧调用。

同一真实探针 Windows 和原生 /var/tmp ext4 修前均 exit 1，修后均 exit 0；新增 secondary/primary LocalFs 恢复、primary 真实 Git/retrieval callback、missing/changed/无新批准负控。双平台九文件各 100/100（旧 99 项 + primary 恢复 1 项），related 各 32/32；真实 ext4 同 dev=2096/ino=832284 替换负控 exit 0。原始命令/读数、初跑夹具与测试错误、全量/check 和未证实项增量记录于 HANDOFF-W2-F1F5.md 的「R-C 修复」。这些是执行者自证；本轮尚无新 exact-head 远端 CI 或独立席位 GO，不解除 RETURN/W3/#441，不合并/部署。

未改权威契约字节：当前 revision sha256:5240077f57b8dea1ac815b5c028f4797380ed7d495a9e7bf85f6020075895534。候选未部署；需要撤回时追加 revert commit，不删 proof/record/sentinel、不降低准入代次、不复活旧 facade。

R-C 最终门禁收口：Windows current 两次 full 均 4064/4044 pass/1 deadline fail/19 skip；Linux current 4064/4060 pass/1 persisted-config fail/3 skip，完整起点 BASE 4058/4054 pass/同 fail/3 skip。Windows BASE 4058/4037 pass/2 不同 fail/19 skip，不证明当前 deadline 根因。Linux npm test 同配置红。full 仍 FAILED，不把定向绿转成 W2 GO。双平台 check 832 syntax/954 architecture、root inventory 10/10、Python 36/36、独立 audit 0 漏洞；原始 summary 与未证实项在 HANDOFF「R-C 修复」。
