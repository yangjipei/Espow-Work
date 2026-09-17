# Legacy Product Manager Assistant 能力拆解与新架构映射

## 1. 文档目的

本文只分析 `references/legacy-product-manager-assistant/` 这个 Reference Implementation，不迁移代码，不定义正式 Skill、Tool、Runtime 或 Workspace Template。

分析目标是把旧项目中的专业方法、执行能力、规则、持久化状态和交互设计拆开，映射到 ESPow Work 的：

```text
Domain
Runtime
Runtime Policy
Skill
Tool
Service
Validator / Gate
Workspace
UI
Legacy Only
```

映射遵循以下边界：

- Skill 只描述“专业问题怎么思考”，不负责路由、会话、文件路径、写入、版本和 Gate。
- Tool 负责确定性执行；Python / Node 只是实现方式。
- Runtime / Harness 负责 Agent Loop、Session、Context、Tool 调用、Approval 和 Runtime Event。
- Domain 负责 Requirement、Artifact、Decision、Open Issue、Thread、Run 和 Workspace State 等 ESPow 产品语义。
- Workspace 保存用户可访问、可编辑、可进入 Git 的正式业务内容；SQLite 保存 App 自身运行状态和索引。
- UI 展示 Workspace、Task、Run、Artifact、Diff、Decision 和 Open Issue，但不成为事实源。

## 2. 分析范围与样本

已覆盖：

- `.agents/AGENT.md`
- `.agents/SKILLS.md`
- `.agents/rules/` 全部 5 个规则文件
- `.agents/skills/` 全部 13 个 Skill
- `scripts/` 全部 4 个 Python 文件
- `requirements/_template/` 全部模板文件
- 真实 Workspace：`requirements/尼日利亚-催收-作业编排能力建设/`
- Legacy 根 `README.md`
- `WORKSPACE-UI.md`
- `dashboard/` 及 `requirements/README.md`，用于补充理解派生视图和目录语义

真实 Workspace 同时检查了正式分析、业务流程、页面流程、原型、PRD、评审、状态、Artifact Index、Grounding、Traceability 和 `workdraft/` 中间产物。

## 3. 总体判断

旧项目已经验证了四个正确方向：

1. 一个 Requirement 对应一个长期 Workspace，多个对话共享正式事实。
2. 用户目录按 Artifact 组织，而不是按 Skill 组织。
3. 专业工作能力按当前场景选择，不采用固定流水线。
4. Decision、Open Question、Artifact、Diff 前的确认以及 Grounding / Traceability 具有长期价值。

但旧实现把不同层级的职责压在文件、Markdown Prompt 和少量脚本上，主要问题是：

- Skill 同时包含专业方法、交互等级、文件路由和写入约束。
- Rules 同时混有 Domain 语义、Runtime Policy、Skill 原则和可程序化校验。
- `state.yaml` 同时承载业务状态、导航指针和派生新鲜度，缺少明确状态机和事件来源。
- 同一 Decision / Open Question 在多个文件重复维护，容易形成多个事实源。
- `snapshot`、结构化 Flow、Grounding、Traceability、Workdraft 和最终文档形成过长派生链，更新时容易失真。
- 校验器能发现路径和哈希问题，但不能证明语义新鲜度；旧样本已经出现“评审为 FRESH，但 PRD 更新晚于评审”的矛盾。
- 旧项目没有真正的 Thread、Message、Run、Session Mapping 和 Approval 生命周期；这些应由新 App、Domain 和 Runtime Adapter 补齐，而不是继续文件模拟。

## 4. 完整能力映射

“保留”表示保留能力和语义，不表示复制旧文件或代码；“重构”表示拆分职责并重新定义 Contract；“淘汰”表示不进入新体系。

| Legacy 能力 | 当前作用 | 新归属 | 保留 / 重构 / 淘汰 | 新实现建议 |
| --- | --- | --- | --- | --- |
| `.agents/AGENT.md` 的产品经理工作场景地图 | 定义发现问题、定义问题、设计解法、推动落地、验证结果的总体角色 | Skill + Runtime Policy | 重构 | 专业工作地图作为内置能力说明；“非固定流水线、按场景选 Skill”进入 Skill 选择策略，不保留单一总 Prompt |
| 一个需求一个目录、多个对话共享同一需求工作区 | 建立 Requirement 的长期事实边界 | Domain + Workspace | 保留 | 建模为 Requirement Workspace；Thread 独立但引用同一 Requirement ID 和当前正式状态 |
| 成果按 `source/analysis/solution/flows/prototype/prd/review/changes` 组织 | 让用户按专业成果而非内部能力访问内容 | Workspace + UI | 保留并简化 | 保留语义分区，不把当前目录清单直接固化为新模板；由 Artifact type 和相对路径共同描述成果 |
| 英文稳定路径、中文 UI 名称 | 避免中英文双目录和链接漂移 | Workspace + UI | 保留 | 路径作为机器标识，中文 label 由 UI / Artifact metadata 提供；不要求所有 Workspace 使用完全相同的目录全集 |
| Source Evidence 与分析结果分离 | 保护原始证据，避免分析覆盖来源 | Workspace + Domain | 保留 | Source 作为只追加或受保护的 Artifact 类别；记录来源、采集时间和引用关系 |
| `.agents/SKILLS.md` Skill 索引 | 罗列 13 个专业工作场景 | Service + UI | 重构 | 由 Skill Registry 提供机器可读元数据，UI 可展示；不能作为执行顺序或独立 Agent 清单 |
| 按当前场景选择 Skill、禁止自动串行 | 防止把产品工作机械化为固定生命周期 | Runtime Policy | 保留 | Runtime 基于 Task、Requirement 状态和显式用户目标选择一个主 Skill；确定性任务可直接走 Workflow |
| 不把用户提出的方案直接当问题 | 区分 solution request 与 problem definition | Skill | 保留 | 进入需求分析专业判断原则；只有任务目标确实是评审既有方案时才以方案为分析对象 |
| 不把模型推测升级为 FACT / DECISION | 防止未确认内容污染正式事实 | Domain + Runtime Policy | 保留 | 模型输出默认 Candidate / Assumption；FACT 和 DECISION 的状态变更必须带来源或用户确认事件 |
| 一个需求只有一套当前有效事实源 | 防止多个文档相互冲突 | Domain + Workspace | 保留并强化 | Decision / Open Issue 建立规范记录和稳定 ID；其他 Artifact 引用而非复制，派生视图可重建 |
| Workspace Routing 表 | 将 Skill 输出硬编码到固定文件路径 | Service + Tool | 重构 | Artifact Resolver 根据 Requirement、Artifact type 和当前版本解析目标；路径策略不进入 Skill Prompt |
| 原型递增版本、不覆盖旧版本 | 保留可视 Artifact 历史 | Domain + Tool + Runtime Policy | 保留 | Domain 定义 Artifact Version；Tool 原子计算下一版本和目标路径；写入前展示 Diff / 新版本计划并确认 |
| `_template` 是唯一模板来源 | 防止模板副本漂移 | Service + Validator / Gate | 重构 | 新体系以后续正式 Template Registry / initializer 为单一来源；本任务不复制旧模板；Validator 检查来源和 Schema |
| Dashboard 是派生视图而非事实源 | 聚合需求、待确认、评审、验收和最近变更 | UI + Service | 保留 | UI 查询 Domain / SQLite 索引并链接 Workspace Artifact；不再生成必须提交的 `dashboard/index.md` |
| `FACT / ASSUMPTION / DECISION / OPEN_QUESTION` 四类语义 | 标记信息的确定性、确认性与待决状态 | Domain | 保留但重新建模 | 保留四种用户可理解语义，拆成 Evidence-backed Statement、Assumption、Decision、Open Issue；避免仅靠 Markdown 标题表达 |
| L0～L3 交互等级 | 粗粒度定义无需交互、条件交互、结果确认和必须交互 | Runtime Policy | 重构 | 不把 L0～L3 固定写进每个 Skill；Runtime 根据风险、未知项影响和动作权限动态计算 interaction requirement |
| Clarification / Confirmation / Decision | 区分补信息、确认结果和产品取舍 | Domain + Runtime Policy + UI | 保留 | 建模为不同 Interaction type；Decision 结果写入 Domain，Clarification 不自动成为 Decision，Confirmation 绑定候选 Artifact / Diff |
| 只询问会改变 Problem / Scope / Goal / Solution / Rule / Acceptance 的未知项 | 控制打扰并避免重复询问 | Runtime Policy | 保留 | 作为交互触发条件；结合已有事实、Open Issue 状态和当前 Task 判断，已回答问题不得重复提问 |
| 原型 Style Reference Gate | 有上下文则继承，无上下文时询问一次 | Runtime Policy + Validator / Gate | 保留并重构 | 检测已有 style evidence 可程序化；是否足够及是否需询问由 Runtime 决定；专业设计方法仍属交互设计 Skill |
| PRD 只组织已确认事实 | 防止写 PRD 时创造产品事实 | Runtime Policy + Validator / Gate | 保留 | 生成前检查 unresolved assumptions / issues，生成后做引用和状态校验；语义审查可由模型执行 |
| PRD 主文档与补充文档固定章节 | 统一旧组织的文档结构 | Workspace Skill / Legacy Only | 有条件重构 | 作为特定团队可选模板或 Workspace Skill，不应成为 ESPow 全局 Domain / Runtime 规则；固定 Web / App 章节属于旧业务模板 |
| `requirement-intake` | 将原始诉求转成可分析上下文，不直接给最终方案 | Skill | 重构 | 保留 Purpose、必要输入、问题边界、输出目标和 Non-goals；移除路径、L1、写入动作 |
| `current-state-analysis` | 还原用户、业务、系统、数据现状 | Skill | 重构 | 保留角色、流程、系统能力、规则、数据、限制和痛点的调查框架；明确证据要求和未知项表达 |
| `requirement-analysis` | 形成问题定义、场景地图、根因和边界 | Skill | 重构 | 保留用户、任务、主流程、阻碍、根因、正常/异常/边界/退出/恢复场景；收敛标准作为专业判断，不直接执行写入 |
| `impact-analysis` | 分析历史能力、依赖和变化影响 | Skill + Tool | 拆分重构 | 模型负责语义影响判断；Tool 负责查找 Artifact 引用、版本、依赖和变更范围；输出聚合为影响分析 Artifact |
| `goal-definition` | 定义用户、业务、系统目标和成功指标 | Skill | 重构 | 保留目标层次、基线、目标值、观察周期、非目标和成功标准；缺少基线时保留为 Open Issue |
| `solution-design` | 发散、比较、收敛方案并形成产品决策 | Skill + Domain | 拆分重构 | Skill 负责候选方案、比较维度、取舍与推荐；确认后的选择写为 Domain Decision，不由 Skill 直接落盘 |
| `business-flow-design` | 将方案转为可执行、可测试的规则、流程和状态模型 | Skill + Validator / Gate | 拆分重构 | Skill 负责角色、触发、分支、异常、并发、幂等和状态语义；结构完整性和引用完整性由 Validator 检查 |
| `interaction-design` | 将任务与流程转成 IA、页面路径、状态和原型 | Skill + Runtime Policy | 拆分重构 | Skill 保留 IA、Page Flow、交互状态和信息优先级方法；Style Gate、版本和写入移出 Skill |
| `product-contract-design` | 补齐数据、状态、权限和异常语义 | Skill | 重构并考虑合并 | 保留研发落地所需的产品语义检查框架；V0.1 可先作为方案/流程或 PRD Skill 的分析维度，不必强制独立主 Skill |
| `product-spec` | 把确认事实和决策组织成 PRD | Skill + Validator / Gate | 拆分重构 | Skill 负责信息架构和表达；Tool 读取模板、生成候选文件与 Diff；Validator 检查章节、Grounding 和未决项误写 |
| `requirement-review` | 从产品、研发、测试和业务视角发现缺口 | Skill + Validator / Gate | 拆分重构 | 语义评审由 Skill / 模型完成；路径、Schema、引用、版本、新鲜度等由 Validator 完成；结果不得仅用 PASS 掩盖 Open Issue |
| `change-clarification` | 区分解释、补充和真实变更，维护当前事实 | Skill + Domain + Runtime Policy | 重点重构 | Skill 判断 Clarification / Supplement / Change；Domain 记录 Change 和受影响对象；Runtime 强制 Change 确认并采用 Delta 流程 |
| `validation-evaluation` | 覆盖验收、上线控制和效果评估 | Skill + Tool + Validator / Gate | 拆分重构 | Skill 负责验收设计和效果解释；Tool 采集/计算确定性指标；Gate 判断是否满足可发布条件；V0.1 先覆盖 Artifact 评审与验收记录 |
| `_workspace.py` 的扁平 YAML 解析/序列化 | 为状态脚本提供轻量配置读写 | Legacy Only / Service | 淘汰实现、保留需求 | 不复制自制 YAML 子集解析器；由 Local Service 使用成熟解析库和显式 Schema；原子写能力复用于文件 Tool 基础设施 |
| `_workspace.py` 的原子写 | 降低文件部分写入风险 | Tool / Service | 保留并重写 | 作为统一 Workspace File Service 的实现细节，配合权限、备份、Diff、确认和错误返回，不暴露为专业能力 |
| `_workspace.py` 的 Requirement 扫描 | 枚举需求目录 | Service | 保留并重写 | Workspace Service 扫描并建立 SQLite 索引；忽略模板、临时目录和无效 Workspace；支持显式刷新 |
| `_workspace.py` 的 Markdown 表格解析 | 从多份表格抽取 Decision / Question | Legacy Only | 淘汰 | 不以脆弱 Markdown 表格解析作为核心 Domain 读模型；规范记录采用结构化 sidecar / metadata，Markdown 为用户可读 Artifact |
| `new_requirement.py` | 校验名称、复制模板、生成 ID、初始化状态 | Tool + Domain | 保留能力、重写 | `initialize_requirement` Tool 接受 Workspace、名称和可选模板；Domain 生成稳定 ID 和初始状态；先预览计划，禁止覆盖已有目录 |
| `validate_workspace.py` | 检查目录、状态键、当前产物、索引、Grounding 和评审新鲜度 | Validator / Gate | 保留并拆分 | 分为 Workspace Schema、Artifact reference、Grounding、Review freshness 等 Validator；结构错误和警告使用机器可读结果 |
| `build_dashboard.py` | 汇总需求状态、开放问题、评审和最近决策 | Service + UI | 保留能力、淘汰 Markdown 生成方式 | Query Service 从 Domain / SQLite 索引读取；UI 实时派生展示，不覆盖文件；Workspace 文件仍为业务事实源 |
| `requirements/_template/overview.md` | 聚合需求基本信息、范围、Decision、Issue 和最新产物 | Workspace + UI | 重构 | Overview 保留为用户可编辑的核心 Artifact，但 Decision / Issue / 最新产物只引用规范记录，避免手工重复维护 |
| `source/` 模板 | 存储未改写证据 | Workspace | 保留 | 保持原文件，补充可选 metadata；不把附件二进制内容迁入 SQLite |
| `analysis/` 模板 | 预建现状、需求、场景和影响分析空文档 | Workspace Skill / Legacy Only | 重构 | 保留内容框架供 Skill 按需生成，不在新 Requirement 初始化时创建所有空文件 |
| `solution/` 模板 | 预建目标和方案文档 | Workspace Skill / Legacy Only | 重构 | 作为按需 Artifact 模板；Decision 从规范 Domain 记录引用，不在多个文档独立维护 |
| `flows/` 模板 | 预建业务规则和状态机 | Workspace Skill | 重构 | 只在对象确有生命周期或复杂流程时生成；规则/状态的结构 Schema 与渲染分离 |
| `prototype/` 模板和样式参考目录 | 管理 IA、原型、截图和风格依据 | Workspace + Runtime Policy | 保留并重构 | Artifact 版本由 Domain 管理，文件留在 Workspace；Style Evidence 是 Source / Reference 类型，不用 README 承担 Gate |
| `prd/` 主文档和补充文档模板 | 固定 PRD 交付结构 | Workspace Skill | 有条件保留 | 作为产品/团队模板，不成为全局唯一结构；主文档与补充文档的配对和版本由 Artifact relationship 管理 |
| `review/` 模板 | 记录评审、验收和效果评估 | Workspace + Skill | 保留并重构 | Review 作为 Artifact，结论带 target Artifact version、reviewer/run、时间和发现项；验收与效果评估按需生成 |
| `changes/` 下 Decision、Open Issue、Change Log 表 | 记录长期决策、问题和变化 | Domain + Workspace | 保留语义、重构存储 | 建立稳定 ID、状态、来源、时间、影响对象和 supersedes 关系；Workspace 输出用户可读记录，避免另有顶层副本 |
| `state.yaml` | 保存 Requirement ID、状态、阶段、当前产物、原型版本、评审状态和更新时间 | Domain + SQLite + Workspace | 拆分重构 | Requirement 身份和少量可移植 metadata 可留 Workspace；当前导航、最近访问、派生新鲜度和索引进 SQLite；状态由事件计算，不手改 |
| `00-snapshot.md` | 给模型快速加载需求摘要 | Service + Runtime | 重构 | 由 Context Service 按当前事实和 Task 动态构造最小上下文；可缓存但不是事实源，也不要求作为长期正式 Artifact |
| `01-decisions.md` 与 `changes/decisions.md` 双路径 | 保存产品决策 | Domain + Workspace | 合并重构 | 只保留一个规范 Decision 集合；Overview、PRD 和 UI 引用 Decision ID；历史变更用 supersedes / status 表达 |
| `02-open-issues.md`、`changes/open-issues.md`、PRD 第 11 章多路径 | 保存待确认问题 | Domain + Workspace + UI | 合并重构 | 一个规范 Open Issue 集合，支持 owner、blocking scope、status、resolution；PRD 和 Dashboard 只投影或引用 |
| `03-artifact-index.md` | 手工维护 Artifact、版本、状态和依赖 | Service + SQLite + Workspace | 重构 | Artifact Index 由扫描器和 Domain 事件派生到 SQLite；需要可移植时可生成只读 manifest，不人工维护 Markdown 表 |
| `business-flow.md/yaml/html` 多格式链 | 同一流程的人读、机器读和展示形式 | Workspace + Tool | 重构 | 明确一个规范源格式，其余由 Tool 确定性渲染；不得由模型把 Markdown 每行机械恢复成伪节点 YAML |
| `page-flow.yaml/md/html` | 页面流程模型及其展示 | Workspace + Tool | 重构 | 结构化 Page Flow 为规范源时，由 Tool 渲染 Markdown / HTML；Schema Validator 检查节点和引用 |
| `prototype-contract.yaml` | 记录原型输入、模式、版本、样式基线和产物路径 | Domain + Workspace + Validator / Gate | 重构 | 拆为 Artifact metadata、style evidence、生成参数和 validation result；删除指向旧 `.agents` 与旧样式目录的环境耦合路径 |
| `workdraft/` | 保存带引用标记、模板锁和候选原型的运行中间产物 | Runtime + SQLite / 临时存储 | 重构 | Candidate / Patch 属于 Run；确认前放运行临时区或 SQLite metadata，确认后写正式 Artifact；不与最终产物长期重复 |
| `document-plan.yaml` | 规划 PRD 章节、模块、输入和引用策略 | Runtime + Skill | 重构 | 复杂 PRD Task 可保留为 Run Plan / candidate metadata；固定模板路径和旧模块名不进入 Domain，不作为长期事实 |
| `template-lock.yaml` | 校验草稿标题、允许/必需引用 | Validator / Gate | 保留能力、重写 | 从所选模板和 Artifact Contract 动态生成校验要求；随 Run 保存，完成后只保留验证摘要，不成为正式业务事实 |
| `prd-grounding.yaml` | 汇总来源哈希、事实和允许/必需引用 | Validator / Gate + Service | 大幅简化 | 保留 source/version/hash 和引用覆盖检查；不复制所有文本形成第二事实源；结果绑定目标 Artifact 版本和 Run |
| `traceability.yaml` | 记录 PRD 章节到 Flow / Prototype / Decision 的映射 | Validator / Gate + Workspace | 保留能力、重构 | 保存稳定引用边，不重复嵌入完整 `ref_index` 文本；机械覆盖由 Tool 检查，业务语义正确性由模型评审 |
| Review `PASS/FRESH/STALE` | 表示评审结果与新鲜度 | Domain + Validator / Gate | 保留并强化 | Review 必须绑定被评 Artifact 的内容哈希/版本；上游或目标变化后由依赖图确定性置为 STALE，不依赖 mtime 推测 |
| Artifact `CURRENT` 与 `Version` | 指示当前产物和版本 | Domain | 保留并重构 | Artifact Version 采用稳定 ID、递增版本、内容哈希、status 和 supersedes；当前版本由 Domain relationship 计算 |
| `dashboard/index.md` | 文件化中文工作台 | UI / Legacy Only | 淘汰文件形态 | 新 Desktop UI 直接呈现我的需求、待确认、待评审、待验收、最近变更，不把派生 UI 写回 Workspace |
| `.DS_Store` 和环境残留 | 无业务作用 | Legacy Only | 淘汰 | 保持 Git ignore，并由 Workspace Validator 提示或由导入清理流程忽略 |

## 5. Rules 拆分结论

旧 Rules 不应整体复制为 Prompt，具体拆分如下：

| Legacy Rule | Runtime Policy | Domain | Skill | Tool / Validator | Legacy Only |
| --- | --- | --- | --- | --- | --- |
| 场景判断后选择 Skill；不固定串行 | Skill 选择、Planning / Workflow 策略 |  |  |  |  |
| 不把方案直接当问题 |  |  | 需求分析原则 |  |  |
| 不把推测升级为事实或决策 | Candidate 默认状态、确认要求 | Statement / Decision 状态迁移 | 各 Skill 的共同边界 | 检查未确认内容进入正式 Artifact |  |
| 一个需求只有一套事实源 | 写入和 Context 读取策略 | Requirement、Decision、Open Issue |  | 重复记录 / 引用一致性检查 |  |
| 成果目录不按 Skill 组织 |  | Artifact type / relation |  | Artifact Resolver | 固定路径表本身 |
| 原始资料与分析分离 | 写入权限策略 | Evidence / Artifact 分类 | Grounding 原则 | Source 保护和引用校验 |  |
| 固定 PRD 章节 |  |  | 可选 Workspace Skill | 模板结构校验 | 全局强制 Web / App 骨架 |
| L0～L3 和三类交互动作 | Interaction / Approval 策略 | Decision / Confirmation record |  | 交互条件的确定性检查 | 每个 Skill 重复声明等级 |
| Style Reference Gate | 缺失上下文时的交互策略 | Style Evidence relation | 交互设计方法 | 检测现有参考、基线与版本 |  |
| 英文路径和目录映射 | Workspace 写入约束 | Artifact identity |  | 路径解析、冲突和版本校验 | 中英文固定映射表作为 Prompt |
| Dashboard 非事实源 | Context / write policy |  |  | 派生查询 | 文件化 Dashboard 生成 |

## 6. Workspace 与持久化边界

### 6.1 应继续保存在 Workspace 文件中的内容

- 原始需求、邮件、会议材料、截图、Excel、PDF、历史 PRD 等 Source Evidence。
- 用户可读、可编辑、可进入 Git 的正式 Artifact：Overview、Analysis、Solution、Flow、Prototype、PRD、Review、Acceptance、Evaluation。
- 产品长期事实的可移植表达：Decision、Open Issue、Change，以及必要的 Artifact metadata / manifest。
- 结构化业务成果，例如确实作为规范源的 Flow / State Model / Traceability 引用边。

### 6.2 应进入 SQLite 的 App 状态

- Thread、Message、Run、Session Mapping。
- Run status、Runtime event、调用的 Skill / Tool、读取与修改文件、错误和时间。
- 最近 Workspace、最近 Requirement、当前选中 Artifact、展开状态等 UI State。
- Workspace 扫描索引、搜索索引、派生 Dashboard 查询数据和缓存。
- Candidate / Diff / Approval 的运行态 metadata；正式写入后保留审计记录。
- Review freshness、Artifact dependency dirty flag 等可由事件重算的派生状态。

### 6.3 应废弃或重新设计的文件状态

- 手工维护的 `current_artifact`、`latest_prototype_version` 和 `review_status`。
- 作为事实源重复存在的顶层与 `changes/` Decision / Open Issue。
- 仅为模型压缩上下文而长期保存的 `00-snapshot.md`。
- 与最终 Artifact 完全或大幅重复的长期 `workdraft/`。
- 复制大量来源文本的 `prd-grounding.yaml` 和 `traceability.yaml`。
- 必须提交和覆盖生成的 `dashboard/index.md`。

### 6.4 FACT / ASSUMPTION / DECISION / OPEN_QUESTION 评估

四种语义都需要保留，但它们不是同一维度的四个互斥“事实类型”：

| Legacy 语义 | 新表达 | 必要字段 / 关系 | 状态变化 |
| --- | --- | --- | --- |
| FACT | Evidence-backed Statement / Confirmed Statement | ID、内容、来源引用、确认方式、创建/更新时间、适用范围 | 新证据可修订或废止，不能无痕覆盖 |
| ASSUMPTION | Assumption | ID、内容、依据、风险、影响范围、验证方式、owner、状态 | Proposed → Validated / Rejected / Superseded |
| DECISION | Decision | ID、问题、候选项、选择、理由、确认人/事件、影响对象、状态 | Proposed → Confirmed → Superseded / Reversed |
| OPEN_QUESTION | Open Issue | ID、问题、为什么要确认、阻塞范围、owner、期限、状态、resolution | Open → Answered / Resolved / Won't Resolve |

关键约束：

- FACT 需要 Evidence 或明确确认来源，不能只是模型高置信度判断。
- ASSUMPTION 可以进入分析和候选方案，但不得伪装成已确认规则进入正式 PRD。
- DECISION 是有审计信息的 Domain Entity，不只是文档中的一句结论。
- OPEN_QUESTION 不等于阻塞；需要额外表达它阻塞哪个 Artifact / Gate / Run。
- 同一陈述可能先是 Assumption，确认后形成 Confirmed Statement 或 Decision；应创建状态迁移 / 关系，不应静默改标签。

## 7. 真实 Requirement Workspace 发现

样本：`requirements/尼日利亚-催收-作业编排能力建设/`。

### 7.1 已验证的有效能力

- `state.yaml` 能提供 Requirement 身份、当前阶段和当前 Artifact 的最低导航信息。
- `01-decisions.md` 保存了 D001～D009 的确认决策，后续 PRD 确实按 D007～D009 收窄了 Web / App 边界。
- PRD Grounding 使用来源路径和哈希，说明旧体系已经意识到上游变化会使下游产物失效。
- Traceability 能表达 PRD 章节与 Business Flow、Page Flow、Prototype、Decision 之间的引用关系。
- Dashboard 能从 Workspace 派生 6 个待确认问题，且自身不声称是事实源。
- `workdraft` 中的 `REF` 标记说明“生成时保留引用，发布时清理标记”的工作方式有审计价值。

### 7.2 明显一致性问题

只读运行旧校验器得到：

- Artifact Index 指向不存在的 `prototype/spec/prototype.md`。
- Artifact Index 指向不存在的 `prototype/prototype-v1.html`。
- `state.yaml` 标记 `review_status: FRESH`，但 PRD 修改时间晚于 Review，校验器提示应为 `STALE`。
- Workspace 包含 `.DS_Store` 和 `prototype/.DS_Store`。

进一步人工检查发现：

- `analysis/requirement-analysis.md` 和 `flows/business-flow.md` 仍要求 App 展示工具、轮次、状态、结果和异常；D008、D009 与最终 PRD 已将其收窄为只展示“有无其他工具正在作业”。上游 Artifact 已语义过期，但未被依赖图标记为 stale。
- `02-open-issues.md` 为空，而 PRD 补充文档中存在 Q001～Q006。Dashboard 通过扫描多个候选文件弥补这一问题，但这证明 Open Issue 没有唯一事实源。
- `03-artifact-index.md` 仍记录旧原型路径，实际文件名已变化；人工维护索引不可靠。
- `prototype/page-ia.md` 与 `prototype/workdraft/page-ia.md` 完全相同，正式原型与 workdraft 原型 HTML 也完全相同，形成无价值重复。
- `prototype/page-ia.md` 描述 5 个页面/状态和丰富自动任务信息，`page-flow.yaml` 与最终 PRD 则明确不新增独立页面、只显示一个布尔提示；原型元数据仍标记为 `new_page`，语义互相冲突。
- `business-flow.yaml` 不是稳定结构化流程，而是把 Markdown 标题、表头、分隔线和正文逐行恢复成 `LEGACY_BFxxx` action；这会制造伪结构和大量无效引用。
- Grounding 与 Traceability 都重复保存来源哈希和完整 ref index，数据量明显膨胀，并存在双份派生数据同步风险。
- Review 虽然写着 `PASS`，但同时有 6 个开发联调前必须关闭的问题；“评审通过”和“Development Ready”不是同一个 Gate，旧状态没有清晰区分。

### 7.3 对新架构的直接启示

1. Artifact、Decision、Open Issue 必须有稳定 ID、版本和单一规范来源。
2. 所有 Review / Gate 必须绑定具体目标版本和依赖版本，不能只绑定文件路径或依赖 mtime。
3. Delta 后应沿依赖图标记受影响 Artifact / Review 为 stale，再由模型做语义影响判断。
4. Grounding 和 Traceability 应保存引用边、版本和校验结果，不复制全部源文本。
5. “Review PASS”“PRD Ready”“Development Ready”必须是不同 Gate。
6. Candidate / Workdraft 属于 Run，不应和正式 Workspace 产物长期并列且无状态区别。

## 8. 结论清单

### 1. 必须保留的核心能力

- 一个 Requirement 一个 Workspace，多个 Thread 共享当前正式状态。
- Workspace First、Artifact Driven、Source Evidence 与产物分离。
- Skill 按工作场景选择，不固定串行。
- FACT / ASSUMPTION / DECISION / OPEN_QUESTION 的语义区分。
- Clarification / Confirmation / Decision 三类交互意图。
- Decision、Open Issue、Change 的长期跟踪和影响关系。
- Artifact 版本、Diff、确认、写入、验证的闭环。
- Grounding、Traceability、Review freshness 和依赖失效能力。
- Dashboard 所代表的待确认、待评审、待验收、最近变更聚合视图。

### 2. 应程序化为 Tool 的能力

- Requirement Workspace 初始化、名称校验、稳定 ID 和初始 metadata 生成。
- Workspace / Artifact 扫描、文件定位和 SQLite 索引。
- Artifact 目标解析、版本号递增、候选文件、Diff / Patch 和原子写入。
- Workspace Schema、Artifact reference、路径冲突和模板结构校验。
- 来源哈希、Grounding 覆盖、Traceability 引用、依赖变化和 stale 计算。
- Flow / Page Flow 的结构校验与 Markdown / HTML 确定性渲染。
- Decision / Open Issue 重复 ID、状态、引用和 Resolution 完整性检查。
- Review 与目标 Artifact 版本一致性检查。
- 派生 Dashboard 查询和状态统计。

这些能力需要重新定义 `input / output / permission / error / test / workspace boundary`，不能直接复制旧 Python。

### 3. 应重新设计为 Skill 的专业方法

- 需求接入：从原始诉求建立可分析上下文，不提前设计方案。
- 现状分析：用户、业务、系统、规则、数据、限制和痛点。
- 需求与场景分析：问题定义、用户任务、主流程、阻碍、根因、边界、异常、退出和恢复。
- 影响分析：历史能力、上下游、角色、页面、数据、接口、兼容性和风险的语义判断。
- 目标定义：用户/业务/系统目标、基线、目标值、成功标准和非目标。
- 方案设计：候选方案、比较维度、取舍、推荐和决策建议。
- 业务流程设计：参与者、触发、前置条件、分支、异常、状态、幂等、并发和退出。
- 页面与交互设计：IA、Page Flow、交互状态、信息优先级和原型目标。
- 产品 Contract 分析：数据、状态、权限和异常语义；V0.1 可作为其他主 Skill 的分析维度。
- PRD 组织：把已确认事实、决策和引用组织为交付文档。
- 需求评审：产品、研发、测试、业务执行多视角语义审查。
- Change Clarification：区分解释、补充与真实变更，并判断语义影响。
- 验收与效果评估：验收设计、上线风险和目标结果解释。

### 4. 应进入 Runtime Policy 的规则

- 一个 Task 默认一个主 Skill + 必要 Tools。
- 根据场景选择 Skill，不按固定产品生命周期自动串行。
- Start / Delta 判断；Delta 只读最小必要上下文并修改受影响 Artifact。
- Token First 的 Context 选择和动态 Snapshot。
- 未确认模型输出默认是 Candidate / Assumption，不得升级为 FACT / DECISION。
- 只有未知项会改变 Problem / Scope / Goal / Solution / Rule / Acceptance 时才必须询问。
- Clarification、Confirmation、Decision 和 Approval 的触发、记录与恢复。
- 正式 Artifact 不静默覆盖；先 Diff，确认后写入并验证。
- 原型和其他需留历史的 Artifact 默认递增版本。
- Style Reference Gate 和已有上下文复用策略。
- PRD 只组织已确认事实；Open Issue 和 Assumption 不伪装成规则。
- Tool 权限、写入边界、高风险动作和失败不可伪造成功。

### 5. 应进入 Domain / Workspace 的长期状态

- Requirement、Workspace、Artifact、Artifact Version、Artifact Relation。
- Decision、Open Issue、Assumption、Evidence-backed Statement、Change。
- Artifact 的 source、status、version、hash、supersedes、depends-on 和 review target。
- Overview、Source、Analysis、Solution、Flow、Prototype、PRD、Review、Acceptance 等正式 Artifact 文件。
- Thread 与 Requirement 的归属关系、Run 与 Thread / Requirement / Artifact 的关联。
- 规范 Decision / Open Issue 的用户可读 Workspace 表达。

其中 Thread、Message、Run、Session Mapping、UI State 和派生索引的主存储应是 SQLite；正式业务 Artifact 和 Source Evidence 的主存储应是 Workspace 文件。

### 6. 可以淘汰的 Legacy 设计

- 把 `.agents/AGENT.md` 当作同时承担角色、路由、交互、写入和 Gate 的总 Prompt。
- 每个 Skill 重复声明相同的路径、交互等级和禁止自动推进规则。
- 固定 Skill → 文件路径映射进入 Skill Contract。
- 自制扁平 YAML 解析器和脆弱 Markdown 表格 Domain 解析。
- 顶层和 `changes/` 中重复的 Decision / Open Issue 文件。
- 文件化、需覆盖生成的 Dashboard。
- 手工维护的 Artifact Index、`current_artifact`、版本和 review freshness。
- Markdown 逐行转换成伪结构化 Business Flow。
- Grounding / Traceability 双份复制完整事实文本和 ref index。
- 与正式产物重复的长期 `workdraft/`。
- 依靠文件 mtime 判断语义新鲜度。
- 把固定 Web / App PRD 骨架当作所有项目的全局规则。
- `.DS_Store` 和指向已不存在旧路径的兼容字段。

### 7. ESPow V0.1 最小能力集合

V0.1 只需支撑一条真实垂直闭环：

1. 选择本地 Workspace，扫描并建立本地索引。
2. 创建或打开一个 Requirement；保留可移植的 Requirement identity 和 Overview。
3. 创建 Thread，并在 SQLite 中保存 Message、Run 和 Session Mapping。
4. Runtime Adapter 接收 Task，判断 Start / Delta，加载最小 Requirement Context。
5. 选择一个主 Skill；首批只需覆盖需求分析、方案/流程、PRD 组织、评审/变更中闭环实际需要的能力，不要求一次迁移 13 个 Skill。
6. 读取 Source、Decision、Open Issue 和直接相关 Artifact。
7. 生成候选 Artifact 修改及明确 Diff；写操作进入 `WaitingConfirmation`。
8. 用户确认后由文件 Tool 原子写入，并生成递增版本或 Patch。
9. Validator 检查 Workspace Schema、Artifact 引用、Grounding、Traceability 和 Review freshness。
10. Domain 更新 Artifact relation、Decision / Open Issue、Run status；SQLite 记录真实 Runtime Event。
11. UI 展示 Requirement、Thread、Run、Artifact、Diff、Decision 和 Open Issue；派生待确认 / 待评审视图，但不创建第二事实源。
12. App 重启后恢复 Thread、Run 和索引，并能继续同一 Requirement 的 Delta Task。

V0.1 明确不需要：完整 13 Skill 迁移、文件化 Dashboard、旧模板全量复制、复杂多格式 Grounding 数据集、Vector DB、多 Agent Team 或云 Workspace。

## 9. 遗漏检查

按用户要求逐项复核：

- Skills：13 个均已逐项映射，并拆出专业方法与非 Skill 职责。
- Rules：5 个规则文件均已按 Runtime Policy、Domain、Skill、Tool / Validator、Legacy Only 拆分。
- Scripts：4 个 Python 文件的真实确定性问题、保留必要性和新归属均已说明。
- Workspace Template：所有成果分区、核心文件和初始化方式均已评估，没有把旧模板视为新模板。
- 真实 Workspace：检查了事实、假设、决策、问题、状态、索引、流程、原型、PRD、草稿、Grounding、Traceability 和 Review。
- 状态：已区分长期业务状态、Run 中间状态、App / UI 状态和派生状态。
- 交互：已覆盖 L0～L3、Clarification、Confirmation、Decision、Style Gate 和写入确认。
- UI：已覆盖路径/中文名称映射、Dashboard 和新 Desktop UI 的事实源边界。
- 限制：未修改 Legacy Reference，未创建正式 Skill / Tool / Runtime / Workspace Template，未开发 Desktop App。

当前未发现本次范围内的明显遗漏。
