# 无头 EDA 任务计算

在网页“蓝图规划任务”中下载任务文件，交给同一版本的客户端运行：

```bash
node src/scripts/run-eda-task.mjs --task /path/line.eda-task.json --proposals 100000
node src/scripts/run-eda-task.mjs --task /path/line.eda-task.json
node src/scripts/run-eda-task.mjs --task /path/line.eda-task.json --proposals 100000 --shard-count 4 --shard-range 0:2 --output /path/part-0-1.json
node src/scripts/run-eda-task.mjs --task /path/line.eda-task.json --proposals 100000 --shard-count 4 --shard-range 2:4 --output /path/part-2-3.json
node src/scripts/run-eda-task.mjs merge --output /path/merged.json /path/part-0-1.json /path/part-2-3.json
```

`--proposals` 是本次追加计算在全部分片上的提案总上限，单位为次，省略时持续计算。`--shard-count X` 将搜索序号稳定分配给 `X` 个分片；`--shard-range A:B` 只运行从 `A` 到 `B-1` 的分片，编号从 0 开始。Node Worker 按并发数从所选范围动态领取空闲分片；省略范围时运行全部分片。各参与者必须从同一份任务文件出发，使用相同的总分片数与互不重叠的范围，输出到不同文件，再执行 `merge`。重叠或缺失分片会被拒绝。部分分片客户端优先搜索宽度模总分片数等于所选分片编号的尺寸；该分片在当前面积下没有对应宽度或对应尺寸已被本客户端占用时，回退到其他空闲的可行尺寸，因此不同客户端的尺寸分工不保证绝对互斥。网页固定使用 32 个虚拟分片，并发模式为 `"auto"`，运行中按吞吐和响应调节实际 Worker 数。无头客户端沿用任务的并发选项：数字 1–32 固定执行容量，`"auto"` 使用同一控制器及可获得的容量提示；提示不足时采用保守上限。旧任务未写并发仍默认为 1。无既有分片元数据的自动任务默认 32 分片，分片数不随运行时并发改变。

Ctrl+C 暂停并保存检查点。网页和无头客户端均只按提案预算结束一轮，不设规划时长。各 Worker 本地计数，在阶段边界汇总；总次数允许少量偏差，不逐提案同步。强制杀死进程、断电或网页刷新只能恢复最后完成阶段的检查点；进行中的局部搜索会重做。合并后的累计提案数和最优结果保留；跨机器没有可信的全局事件时钟，因此曲线只在合并时的准确总计数处记录当前最优面积，后续规划继续积累下降点。

默认输出到输入文件旁的 `.continued.json`，使用 `--output` 指定其他路径。每个已完成阶段以原子替换落盘；相同输出路径用锁文件防止重复写入。异常断电遗留锁文件时，应先确认没有相关进程，再手动移除锁。输出文件可以重新导入网页或继续交给客户端。

任务文件包含请求、进度、已验证最优结果、待验证候选、布局种子池与搜索轮次。它不是 Worker 调用栈快照：未完成的局部搜索可能重做。未知算法版本明确拒绝导入，不静默丢弃检查点。

`compact-portfolio-1`、`compact-portfolio-2`、`compact-breadth-1` 的旧任务支持迁移为当前盒外存取线规则：保留历史次数、耗时与曲线；最优蓝图移除存取线后重新计算面积，通过边界及真实仿真验收时，只更新曲线末点并继续使用该布局。旧布局不合格时保留历史，从原累计次数继续寻找有效结果。旧种子池和分片内部状态重建，因此协作计算应先迁移得到同一份当前版本任务，再分发给各参与者。首次迁移会额外执行一次验收；取消、超时或服务异常时保留原始输入文件。已经被旧版本清空并覆盖的历史须从原任务导出或备份恢复。

仿真固定使用 dense-v2、每仿真秒两个真实 tick。成功结果及输入、验证报告保存到 `.temp/eda/success/`。网页任务保存在独立 IndexedDB 中，不参与同步；清除网站数据会删除本机任务，下载的任务文件可用于恢复。

当前实现支持 CPU Worker 并发与协作分片。GPU 计算后端尚未实现；未来后端可使用相同分片编号协议。
