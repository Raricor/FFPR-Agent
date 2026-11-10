# 任务 103(桥插件 0.14.6,实验性):按需只读加载任意地图的数据——任务 80 的三步实验

工作目录 `bridge/`。只改 `bridge/src/`、`bridge/README.md`、`src/Version.cs`。不碰 `../dsh/`、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**、不装插件(Claude 来装、来做实验),**不用 docker、不绕开沙箱**(编不了就在回报里说明，Claude 在外面编)。桥插件**只读**:不改游戏数据和存档，**不切换地图、不实例化地图、不创建实体**。

**先读** `../.deps/tmp/research-80/report.md`(任务 80 的调查报告：地图数据以什么形式存在、加载链 `MapManager.RequestLoadMap → MapPackageLoader → MapAssetLoader → MapAssetData → MapModel`、哪些方法只读、哪些绝对不能碰、推荐的三步实验)。反编译代码在 `../.deps/ff5/decompiled/`。

## 起因

用户 11-10:要在地图模型上把一整段行动推演好(开宝箱、触发机关、存档、刷怪的区域),让移动连续;可地图记录只有去过的图，落点只记了 13%。任务 80 查明：游戏里每张图的碰撞、实体(出口 `map_id`/`point_id`、宝箱、事件、机关)是分开的文本资源;桥插件可以只读地加载任意地图的这些文本(像 `monsterai` 读游戏已加载的 `TextAsset` 那样),不实例化地图。这个任务把报告里的三步实验做成三个只读查询，由 Claude 在真机上跑。

## 做法

三个查询，都标“实验性”(README 写明):

1. **`mapinfo`**(第一步，诊断):返回 `MapManager.AssetPackageName` 的值、当前地图在 `Map` 主数据里的行(`MapName`、`AssetName` 等)、当前已载入的地图包 / 模型列表(报告里的 `packageList`/`mapModelList`,读得到什么给什么)。
2. **`mappackage`**(参数 `map`:地图号):按报告的只读入口(`MapPackageLoader` 加载清单，不走 `RequestLoadMap`)取这张图的资源清单(每个资源的名字和类型)。加载是异步的：在游戏线程上推进(报告说要每帧 `UpdateLoad()`),设超时(默认 5 秒),超时就返回已有的部分和 `timeout: true`;不实例化。
3. **`mapasset`**(参数 `map`、`asset`(名字，比如碰撞或 `entity_default`)、`offset`、`limit`):只读地加载这张图的一个文本资源，按字符分页返回原文(`limit` 默认 20000、上限 60000)。同样异步、超时、不实例化。

要求:
- **绝对不调**报告里列为不能碰的方法(`RequestLoadMap`、`ChangeMap`、`CreateMapModel`、`SetMapModelData`、`CreateMapEntity`、`MapColliderCreator.CreateMapColliders` 等);
- 加载的资源用完就释放(如果加载器有对应的释放 / 卸载方法，用它;没有就在 README 写明可能留在内存里);
- 同一时间只做一个加载，第二个请求排队或直接报“忙”;
- 出任何异常都只回错误，不影响游戏线程(包 try/catch,照现有查询的做法);
- 只编进 FF5(条件编译),其他五作不受影响。
- 版本号 0.14.6,README 写清三个查询、参数、限制、风险。

## 回报

不超过 30 行：三个查询用到的类和方法(文件名)、哪些是推断、怎么保证不实例化地图、`dotnet build -p:Game=ff5` 的结尾(或为什么编不了)、建议 Claude 真机实验的顺序和每步看什么。
