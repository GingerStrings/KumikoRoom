# FL Studio 创作资料室设计

日期：2026-07-13
状态：第一版已实现并完成本机验收

## 1. 产品目标

创作资料室读取用户指定目录中的 FL Studio 21 工程，将 `.flp` 内部结构转换为可浏览、可搜索、可比较的工程档案。

第一版围绕 Pattern、MIDI、软音源、Playlist、Mixer、自动化和工程依赖展开。所有工程文件保持只读。用户打开资料室后应当能快速回答：

- 我有哪些工程，它们最近发生了什么变化？
- 这个 FLP 内部包含哪些 Pattern、音符、通道、插件和路由？
- 整首作品的编曲结构与音乐特征是什么？
- 工程是否缺少插件、采样或其他依赖？
- 哪些 Pattern、Channel 或 Mixer 结构值得检查？
- FL Studio 自动备份之间有哪些实际变化？

## 2. 用户可获得的能力

### 2.1 工程库

用户可以添加一个或多个本地目录。资料室执行增量扫描，建立工程库。

工程库提供：

- 工程卡片、列表与搜索。
- 按最近编辑、BPM、推测调式、插件、解析状态和依赖状态筛选。
- 主工程、工程目录、Render 和自动备份的关联结果。
- 扫描进度、上次分析时间和需要关注的解析问题。
- 打开工程仪表盘、在资源管理器中定位文件、使用 FL Studio 打开工程的入口。

独立 `.flp` 可以成为一个工程。包含项目数据目录时，FLP、Backups、Renders 和相关资源归入同一工程。关联不确定的文件进入待确认区域，由用户手动归组。

### 2.2 单工程仪表盘

每个工程拥有独立仪表盘，展示：

- FL Studio 版本、BPM、PPQ、时长、标题、作者、创建时间和累计编辑时间。
- Pattern、Channel、插件、Mixer Insert、Automation 和 Playlist Clip 数量。
- 音域、音符密度、力度分布、节奏分布和 Pattern 复用情况。
- 编曲结构缩略图。
- 插件、采样和外部依赖状态。
- 解析覆盖率、确定问题和结构提醒。
- 最近自动备份与近期结构变化。

仪表盘健康状态只描述文件完整性、依赖状态和解析覆盖率，不评价音乐质量。

### 2.3 音乐指纹

仪表盘中央提供“音乐指纹”可视化。第一版根据 MIDI 和工程结构生成，包含：

- 音域与主要音区。
- 音符密度和节奏活动度。
- 力度分布。
- Pattern 复用强度。
- 轨道与声部数量。
- 推测调式、和弦集合与旋律走向。
- 不同段落的结构能量。

调式、和弦和段落属于推断信息，界面必须显示可信度和依据。第一版不进行音频频谱或响度分析。

### 2.4 编曲分析

编曲分析页将 Playlist 转为可缩放时间线：

- Pattern Clip、Automation Clip 和可识别的 Audio Clip。
- Playlist 轨道分布。
- Pattern 在整首作品中的出现位置和复用关系。
- 不同区间的音符、轨道和自动化密度。
- 长空白、重复区段和结构变化点。
- 用户自定义的 Intro、Verse、Drop、Outro 等段落标记。
- 自动段落建议及其可信度。

### 2.5 Pattern 与 MIDI 分析

Pattern Explorer 提供：

- Pattern 列表、名称、长度和使用状态。
- Piano Roll 可视化。
- Channel 与声部映射。
- 音符数量、音域、时值、力度和节奏分布。
- Pattern 相似度和内容重复关系。
- 空 Pattern、未使用 Pattern 和近似重复 Pattern 提醒。
- 推测调式、和弦与旋律轮廓。

### 2.6 Channel、插件与 Mixer

资料室展示：

- Channel Rack 完整清单。
- 每个 Channel 使用的生成器、采样器或插件。
- FL 原生插件与第三方插件分类。
- 插件实例所在的 Channel 或 Mixer 插槽。
- Mixer Insert、效果器链、发送和可可靠读取的路由关系。
- 自动化对象、控制目标和覆盖范围。
- 缺失插件、未知插件状态和失效关联。

第三方插件内部参数和所有 FL 原生插件状态不承诺完整解析。无法理解的状态会保留摘要并显示解析范围。

### 2.7 依赖与结构诊断

诊断分为三类：

1. 确定问题：缺失文件、无法解析的 FLP、损坏关联、明确缺失的插件。
2. 结构提醒：空 Pattern、未使用 Channel、未进入 Playlist 的内容、长空白和近似重复结构。
3. 音乐推断：调式、和弦、段落与旋律走向，必须显示可信度。

用户可以从诊断项跳转到对应 Pattern、Channel、Mixer Insert 或依赖路径。

### 2.8 自动备份与版本比较

版本功能作为工程详情中的次级模块，利用 FL Studio 已有自动备份：

- 检查全局 Backup 目录与项目数据目录中的 Backups。
- 将高可信度备份关联到主工程。
- 显示自动备份时间线。
- 比较任意两个分析快照中的 Pattern、音符、Channel、插件、Playlist、Mixer 和指标变化。
- 打开备份所在位置。

资料室不会额外复制 FLP，也不会自动覆盖主工程。模糊匹配的备份需要用户确认。

### 2.9 工程报告

工程详情提供“编辑档案”报告视图，汇总工程信息、音乐指纹、编曲结构、插件与依赖状态。第一版支持适合打印的页面布局；独立 PDF 导出可在后续迭代中增加。

## 3. 核心使用流程

```text
首次进入资料室
→ 添加工程目录
→ 后台发现并解析 FLP
→ 工程库逐步出现可用项目
→ 打开某个工程仪表盘
→ 查看音乐指纹与工程摘要
→ 深入查看编曲、Pattern、插件、Mixer 和依赖
→ 必要时查看自动备份和版本差异
```

后续进入资料室时使用缓存立即展示工程库，同时在后台检查发生变化的文件。

## 4. 视觉方向

视觉设计采用三种语言的组合：

- “雨后谱室”作为整体材质与排版：浅色纸感、柔和蓝灰、安静留白，与现有 KumikoRoom 保持连续。
- “透明声场”作为音乐指纹：珍珠白、克制的光谱色和半透明层次，形成工程仪表盘的视觉记忆点。
- “编辑档案”用于工程报告：奶油纸、深蓝、杂志式网格和档案标记。

工程仪表盘优先保证信息清晰和长时间阅读舒适。光谱效果集中在音乐指纹区域，不覆盖正文、表格和告警。

## 5. 第一版解析范围

第一版以用户当前使用的 FL Studio 21 和以 Pattern、MIDI、软音源为主的工程为主要目标。

解析内容包括：

- 工程元数据和 FL Studio 保存版本。
- Arrangement、Playlist Track 和 Clip。
- Pattern、控制器和音符。
- Channel Rack、生成器、采样器和基础参数。
- VST 2/3 插件标识。
- Mixer Insert、效果器插槽和可识别路由。
- Automation 和可识别控制目标。
- 外部文件路径和依赖。
- 未识别事件与解析警告。

第一版暂缓：

- 修改或保存 FLP。
- 完整还原所有插件内部参数。
- 音频波形、频谱、响度和母带分析。
- 同时保证大量历史 FL Studio 版本。
- 对作品质量进行主观评分。
- 自动修改、清理或恢复工程。

## 6. 技术架构

### 6.1 解析边界

采用混合适配方案：

```text
Web 页面
  ↓
Studio API
  ↓
KumikoRoom FlpAnalysis 模型
  ↓
FlpParser 接口
  ├─ PyFLP 只读适配器
  └─ 后续 FL Studio 21 补充解析器
  ↓
FLP 文件
```

第一版使用 PyFLP 读取通用工程结构。PyFLP 只允许出现在适配器模块中，API、数据库和前端依赖 KumikoRoom 自己的稳定数据模型。缺失的关键字段根据真实工程样本逐项增加补充解析。

PyFLP 采用 GPLv3。项目进入公开分发前需要单独复核依赖与整体许可证方案。

### 6.2 后端模块

```text
apps/api/kumikoroom/studio/
├─ models.py
├─ scanner.py
├─ service.py
├─ repository.py
├─ analyzer.py
├─ diff.py
└─ parsers/
   ├─ base.py
   └─ pyflp_adapter.py
```

- `scanner`：发现工程、自动备份、Render 和依赖。
- `parsers`：将 FLP 转为统一分析模型。
- `analyzer`：生成统计、音乐推断和结构诊断。
- `repository`：保存工程、分析快照、任务状态和关联关系。
- `diff`：比较两个分析快照。
- `service`：增量扫描、稳定等待、任务编排和失败恢复。

解析任务使用进程内单工作队列，避免批量扫描占满磁盘和 CPU。未来确有规模需求时再更换持久任务系统。

### 6.3 前端模块

```text
/studio
├─ StudioLibrary
├─ ProjectCard
├─ ProjectFilters
└─ ScanStatus

/studio/projects/[id]
├─ ProjectDashboard
├─ MusicalFingerprint
├─ ArrangementAnalysis
├─ PatternExplorer
├─ ChannelAndPluginView
├─ MixerGraph
├─ DependencyReport
└─ VersionTimeline
```

大型工程数据按页面分段加载。Pattern 列表、插件清单和版本列表在需要时使用虚拟滚动。

## 7. 数据模型

核心实体：

```text
StudioProject
├─ ProjectFile
├─ FlpAnalysisSnapshot
│  ├─ ProjectInfo
│  ├─ ArrangementSummary
│  ├─ PatternSummary[]
│  ├─ ChannelSummary[]
│  ├─ PluginInstance[]
│  ├─ MixerInsertSummary[]
│  ├─ AutomationSummary[]
│  ├─ DependencyReference[]
│  ├─ MusicalFingerprint
│  └─ AnalysisDiagnostic[]
├─ BackupAssociation[]
└─ ScanTaskState
```

SQLite 保存路径、修改时间、内容哈希、结构化分析、诊断和版本关系。原始插件状态块默认不发送给前端。

## 8. 扫描与关联规则

用户可以配置多个工程根目录。扫描器检查 `.flp`、工程数据目录、Render 以及 Backup/Backups 子目录。

FL Studio 默认全局自动备份目录是用户数据位置下的 `Documents\Image-Line\FL Studio\Projects\Backup`。FL Studio 也支持将备份保存到项目数据目录。

备份关联使用：

- 规范化文件名。
- FLP 内部标题。
- 保存时间。
- Channel、Pattern 和插件结构指纹。

关联结果包含可信度。低可信度候选不会自动并入工程。

文件大小和修改时间稳定后才进入解析。只有发生变化的文件重新分析，缓存有效的工程立即可用。

## 9. 状态与错误处理

工程解析状态：

```text
discovered → queued → parsing → ready / partial / failed
                                  ↓
                              stale on change
```

- `ready`：核心结构解析完整。
- `partial`：工程可浏览，部分事件或插件状态未知。
- `failed`：文件损坏、格式不支持或解析器异常。
- `stale`：磁盘文件已变化，暂时展示上一次成功结果。

单个工程失败不影响整批扫描。失败时保留上一次成功分析，并提供错误阶段、可读说明、重新解析和打开文件位置操作。

扫描范围仅限用户添加的目录和已确认的 FL Studio 数据目录。默认不跟随超出根目录的符号链接或目录连接。

## 10. 测试与验收

实现需要覆盖：

- PyFLP 适配器契约和稳定分析快照。
- Pattern、音符、编曲、插件、依赖和推断算法。
- 多目录扫描、缓存、增量解析和备份关联。
- 单文件失败、部分解析、损坏文件和扫描边界。
- Studio API 与前端各状态。
- 工程仪表盘、可视化和大型列表。

真实验收使用用户指定的 3–5 个 FL Studio 21 工程，以只读方式和 FL Studio 界面对照。解析前后原始文件哈希必须完全一致。

第一版产品验收路径：

```text
添加工程目录
→ 自动发现 FLP
→ 浏览工程库
→ 打开工程仪表盘与音乐指纹
→ 查看 Playlist、Pattern、MIDI、插件和 Mixer
→ 查看依赖与结构诊断
→ 查看自动备份时间线和版本差异
```

性能目标：缓存命中时工程库约 2 秒内可浏览；单个普通 FLP 的解析目标控制在数秒内；批量解析在后台执行且页面保持可操作。

## 11. 实施顺序

1. 建立 Studio 数据模型、数据库和扫描根目录配置。
2. 建立 PyFLP 只读适配器与真实工程解析探针。
3. 完成工程库、增量扫描和解析状态。
4. 完成工程仪表盘与音乐指纹基础数据。
5. 完成 Playlist、Pattern、MIDI 和插件页面。
6. 完成 Mixer、自动化、依赖和诊断。
7. 完成自动备份关联与分析快照差异。
8. 完成“雨后谱室 + 透明声场 + 编辑档案”的视觉实现与综合验收。

## 12. 参考资料

- [PyFLP 功能文档](https://pyflp.readthedocs.io/en/latest/)
- [PyFLP Project API](https://pyflp.readthedocs.io/en/latest/reference/project.html)
- [Image-Line：FL Studio Project File](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/fformats_open_flp.htm)
- [Image-Line：File Settings 与自动备份](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/envsettings_files.htm)
- [Image-Line：Project Data Folder](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/songsettings_settings.htm)

## 13. 本机配置、隐私与验收记录

运行入口为 `/studio`。扫描根目录通过页面登记；分析数据库默认位于 `user-data/studio/kumikoroom-studio.sqlite3`，可由 `KUMIKOROOM_STUDIO_DB_PATH` 覆盖。源 FLP、自动备份、依赖文件和本机分析数据库均视为私人数据，不进入 Git。

解析器只读打开源 FLP。版本确认只写入数据库关联关系；产品没有保存、复制、恢复或覆盖 FLP 的入口。自动备份发现范围包括工程数据目录中的 `Backup`/`Backups` 和 FL Studio 标准用户备份目录。高可信度关联自动进入时间线，低可信度候选等待确认。

可选真实工程契约由 `KUMIKOROOM_TEST_FLP_PATH` 启用：

```powershell
$env:KUMIKOROOM_TEST_FLP_PATH="D:\private\project.flp"
python -m pytest apps/api/tests/test_studio_local_flp.py -q
```

2026-07-15 的本机验收从用户现有目录中发现 22 个有效大小的真实 FLP，筛出 12 个具备 Pattern 与 Channel 核心结构的 FL Studio `21.2.3.4004` 样本。最终以匿名编号 `local-flp-01` 至 `local-flp-05` 运行契约，覆盖两个工程组、主工程与自动备份：5/5 解析成功，版本、速度、Pattern、Channel 均可读取，且每个文件解析前后 SHA-256 完全相同。私人路径、工程名、FLP、数据库和截图均未提交。

验收同时确认一个运行时边界：PyFLP 2.2.1 的空事件基类枚举在 Python 3.13 行为发生变化。适配器提供幂等兼容处理，并有独立回归测试；兼容处理不读取额外文件，也不改变 FLP 数据。

第一版限制继续遵循第 5 节：解析重点为 FL Studio 21；插件内部状态和部分路由可能产生部分解析；音乐理论与段落结果属于带可信度的推断；音频分析、工程编辑、自动修复和版本恢复暂不提供。
