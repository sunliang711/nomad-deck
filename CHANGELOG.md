# ChangeLog

## [Unreleased]

### Added
- Nomad Job 中心新增基于 HCL 结构的积木编排，支持多 Group、多 Task、子元素规则、复制、拖拽及撤销重做。

### Changed
- 可视化编辑保留表达式、注释、locals 和未知扩展，提交前等待最新草稿生成，修改立即使旧 Plan 失效。
- HCL 与 JSON 切换增加源码恢复与完整转换保护。
