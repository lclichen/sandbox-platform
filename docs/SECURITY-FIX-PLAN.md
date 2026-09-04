# 安全修复计划（2026-09-04）

> 总计划与任务清单见 `D:\MyCourses\26Q3\LabTrainingProject\pi-web\docs\dev\修复计划-2026-09-04.md`。
> 本文件只列本仓库（sandbox-platform）的执行项，完成后打勾并注明 commit。

## Phase C 任务

- [x] // 853a004 fail-closed 启动：JWT_SECRET 未设→自动生成临时随机值+告警；显式设为已知
      弱值→任何环境拒绝启动。种子 admin 用默认弱口令→强制 `must_change_password=1`。
- [x] // 853a004 `EXECUTOR_KIND` 默认 `mock`→`auto`；production 拒绝 mock（显式也不行）；
      mock 执行器 env 改白名单，杜绝平台机密泄入。
- [x] // 7dc86c0 PTY 一次性 ticket 鉴权（60s 单次）+ WS maxPayload + input 限速。
- [x] // 7dc86c0 tools 资源边界：stderr 截断、read 上限、grep 行长/pattern/文件数预算。
- [x] // 7dc86c0（0002_token_version 迁移） 密码重置吊销凭证；access token `tv` claim + token_version 校验。
- [x] // fcf27e4 生命周期每容器互斥锁；reaper/snapshot/destroy 状态复查；退出码校验。
- [x] // fcf27e4 快照恢复原子化（临时目录 + 换名）。
- [x] // fcf27e4 backup 保留策略；migrate:rollback 破坏性确认。
- [x] // 7dc86c0 JWT 固定 HS256；登录时序一致；change-password 限速；admin 自我保护。
- [x] // fcf27e4 文档漂移（503→501、seed 说明）；/metrics 默认要求 token。

## 验收

- `npx vitest run` 全绿（含新增：config fail-closed、pty ticket、tools caps、
  lifecycle 锁、token_version、backup retention 用例）。
- 测试方案 S-08/S-09/S-10 用例通过（见 pi-web docs/dev/全流程测试方案.md §5a）。


## 执行记录

| 提交 | 内容 |
|---|---|
| 853a004 | C1-C2：fail-closed 启动（弱 JWT 占位符全域拒绝/未设即临时随机、admin 弱口令强制改密、EXECUTOR_KIND=auto、mock env 白名单、限速默认开）+ config.failclosed.test.ts |
| 7dc86c0 | C3-C5+C9：PTY 一次性 ticket+输入限速、tools 资源上限（read/stderr/grep/ReDoS）、token_version 即时吊销+重置吊销 refresh、登录时序、change-password 限速、admin 自保护 + pty/security.caps 测试 |
| fcf27e4 | C6-C10：每容器互斥锁+reaper 状态复查+执行器退出码校验+活实例拒删 overlay、恢复原子化、backup 保留+主入口 bug（导致 128 个积压文件的直接原因）、rollback --force、/metrics 默认关闭、文档漂移 |

### 验证

- npx vitest run：241 passed / 7 failed（7 个为预存失败：extension-client/api-key 冒烟依赖外部 pi-sandbox-extension 环境，HEAD 上同样失败）
- 新增测试：config.failclosed(5)、pty ticket 流(8)、security.caps(8)、container-lock(4)
- 本地 .env 的弱 JWT 占位符已替换为随机 64-hex（未入库）
