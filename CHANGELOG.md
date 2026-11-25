# ChangeLog

## [Unreleased]

### Added
- Nomad Job 中心新增基于 HCL 结构的积木编排，支持多 Group、多 Task、子元素规则、复制、拖拽及撤销重做。

### Changed
- 可视化编辑保留表达式、注释、locals 和未知扩展，提交前等待最新草稿生成，修改立即使旧 Plan 失效。
- HCL 与 JSON 切换增加源码恢复与完整转换保护。

### Fixed
- systemd 就绪后重置启动计数，防止正常重启耗尽限额；退出码 75 不再误触发自动回退，安装脚本新增已有服务修复入口。
- Allocation 详情在 Task 延迟出现后自动选择日志 Task，刷新同一 Allocation 时重新订阅日志。
