# Nomad HCL 积木编排交付

## 目标与实现

将 Job 中心的单 Group、单 Task 表单替换为按 Nomad HCL 规则编辑的结构树。Job 下可以添加多个 Group，Group 下可以添加多个 Task，Task 中可以组合 driver 属性以及 config、resources、env、template 等子块。元素列表根据父级和 driver 提供字段，单个块与可重复块分别限制。

新增 HCL 文档解析及渲染服务，采用语法树和表达式原文保存定义，保留注释、变量、locals、heredoc 和未知配置。前端提供属性面板、键值与数组输入、原生表达式、复制、删除、排序、跨父级拖拽以及撤销重做。切换模式和提交会等待最新草稿，编辑后清除旧 Plan，并丢弃过期的预览响应。JSON 未修改时切回恢复原 HCL，修改后无法完整转换则保留 JSON。

## 变更范围

- jobspec 新增通用文档模型、Nomad 1.11.2 结构规则和解析渲染测试，保留原有 JobSpec 接口。
- jobs 与 API 新增管理员源码操作 hcl-tree 和 hcl-tree-render，沿用已有权限与错误格式。
- Web 新增积木编辑组件、结构操作工具及八项单元测试，Job 中心接入模式切换、完整源码保存和实时预览。
- 运行台在 Allocation 详情补全后选择可用 Task，手动刷新时重新订阅日志，修复新任务和已完成任务的日志空白。
- 更新内嵌前端产物，新增编排机制说明与 ChangeLog。

无数据库迁移、环境变量、配置项或依赖升级。原有已提交功能保留。

## 验证

通过全量 go test -race ./...、go vet ./...、前端结构操作测试及 TypeScript/Vite 生产构建。源码往返测试使用本机 Nomad 解析原文和生成内容，比较 Job JSON，验证语义一致。接口测试覆盖管理员权限、只读用户拒绝和错误输入；结构测试覆盖重复块、错误层级、表达式及文档大小限制。

远程控制面部署在 https://10.2.69.8:8555，Nomad 版本 1.11.2。验收通过 Tabbit 实际操作页面完成：新增 Group/Task/config、env 多键、resources 单例、重复 template、复制 Task 和 Group、上下排序、撤销重做、跨 Group 拖拽、driver 配置切换及 HCL/JSON 往返。

页面生成 visual-builder-ui 批任务，包含两个 Group、四个 Task、八个 template；Validate、Plan、Apply 成功。app 和 workers 的 Allocation 都为 complete，四个 Task 退出码均为 0，日志包含 visual-one、visual-two 与 builder-file-ok。重新载入保留原始注释、locals、变量表达式及完整任务树。属性形式 env 占用单例位置，混用 env 属性与块的非法草稿被页面诊断并禁用 Plan。

全量测试首次运行中既有定时任务测试出现一次重复窗口异常，单独复跑及最终全量运行通过；本任务未改动定时任务逻辑。

## 部署与边界

替换控制面的内嵌前端与二进制，持久化目录保持原部署映射。部署前通过页面完成备份。只清理本次创建的测试 Job，保留原有 ui-hello、ui-vault-secret 和用户模板。

规则表以 Nomad 1.11.2 为基准，覆盖九十七种结构及五种驱动配置；未知扩展保留，最终语义以目标集群的 Validate 和 Plan 为准。自更新不纳入本次验收。使用方式与校验边界见 docs/JOB-BUILDER.md。
