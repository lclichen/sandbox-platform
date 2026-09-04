# 安全修复计划（2026-09-04）

> 总计划与任务清单见 `D:\MyCourses\26Q3\LabTrainingProject\pi-web\docs\dev\修复计划-2026-09-04.md`。
> 本文件只列本仓库（sandbox-platform）的执行项，完成后打勾并注明 commit。

## Phase C 任务

- [C1] fail-closed 启动：JWT_SECRET 未设→自动生成临时随机值+告警；显式设为已知
      弱值→任何环境拒绝启动。种子 admin 用默认弱口令→强制 `must_change_password=1`。
- [C2] `EXECUTOR_KIND` 默认 `mock`→`auto`；production 拒绝 mock（显式也不行）；
      mock 执行器 env 改白名单，杜绝平台机密泄入。
- [C3] PTY 一次性 ticket 鉴权（60s 单次）+ WS maxPayload + input 限速。
- [C4] tools 资源边界：stderr 截断、read 上限、grep 行长/pattern/文件数预算。
- [C5] 密码重置吊销凭证；access token `tv` claim + token_version 校验。
- [C6] 生命周期每容器互斥锁；reaper/snapshot/destroy 状态复查；退出码校验。
- [C7] 快照恢复原子化（临时目录 + 换名）。
- [C8] backup 保留策略；migrate:rollback 破坏性确认。
- [C9] JWT 固定 HS256；登录时序一致；change-password 限速；admin 自我保护。
- [C10] 文档漂移（503→501、seed 说明）；/metrics 默认要求 token。

## 验收

- `npx vitest run` 全绿（含新增：config fail-closed、pty ticket、tools caps、
  lifecycle 锁、token_version、backup retention 用例）。
- 测试方案 S-08/S-09/S-10 用例通过（见 pi-web docs/dev/全流程测试方案.md §5a）。
