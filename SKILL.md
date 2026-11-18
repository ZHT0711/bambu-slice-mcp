---
name: bambu-slice
description: 用本机 Bambu Studio / OrcaSlicer 的命令行做无头切片和参数寻优。当用户说"重新切片""改层高/支撑/填充再切一次""这个参数到底多花多少时间""不打开拓竹直接出 gcode""哪种参数最快"时使用。不需要 GUI，不需要电脑控制权限。
---

# Bambu 本地切片与寻优

配套 MCP：`bambu-slice`（本仓库）。工具齐全时优先调 MCP；没有 MCP 时按下面的命令自己拼。

## 先确认环境

```
detect_slicer          # 拿到 binary、profilesRoot、vendor（应为 BBL）和预设数量
list_presets {kind:"process", query:"0.28"}
```

装的是拓竹还是 Orca 都能用，两者都带同一套 `BBL` 预设树。检测不到就设 `BAMBU_SLICER_BIN`，
或者给 `slicer_path`。

## 场景一：改参数重新切片

```
build_project {
  input: "D:/.../part.stl",
  output: "D:/.../part_0.28.3mf",
  machine: "Bambu Lab X1 Carbon 0.4 nozzle",
  process: "0.28mm Extra Draft @BBL X1C",
  filament: "Bambu PLA Basic @BBL X1C",
  overrides: { layer_height:"0.28", wall_loops:"3", sparse_infill_density:"10%",
               sparse_infill_pattern:"gyroid", enable_support:"1",
               support_type:"tree(auto)", support_on_build_plate_only:"1" }
}
slice_project { input: "D:/.../part_0.28.3mf" }
```

`slice_project` 会返回 `printTime` / `filamentGrams` / `supportsUsed`，直接把这三个数报给用户，
不要自己估。

## 场景二：参数寻优（最常用）

用户问"怎么打快点""支撑太多了""这个值调多少合适"时，**别猜，扫一遍**：

```
optimize {
  input: "D:/.../part.stl",
  sweep_param: "support_threshold_angle",
  values: ["20","25","30","45"],
  machine: ..., process: ..., filament: ...,
  base_overrides: { ...固定不变的设置... }
}
```

返回按打印时间升序的表，以及 `best`（含 `savedAs`，最优文件已复制出来）。
扫 4 组大约 3–4 分钟，一次工具调用里跑完，告诉用户大概要等一会儿。

适合扫的键：`support_threshold_angle`、`layer_height`、`sparse_infill_density`、
`wall_loops`、`top_shell_layers`、`support_type`、`brim_type`。
想对比"开/关支撑"，扫 `enable_support` 的 `["1","0"]`。

## 实测结论（可直接引用）

对一个 137 cm³ 的风道半件（0.28 层高 / 3 墙 / 10% gyroid / 树状支撑仅热床）：

| 支撑阈值 | 时间 | 耗材 |
|---|---|---|
| 20° | 6h15m | 185.1 g |
| 25° | 6h38m | 191.9 g |
| 30° | 7h14m | 202.4 g |
| 45° | 8h41m | 229.7 g |
| 关支撑 | 4h13m | 152.1 g |

**阈值越小，支撑越少。** 直觉上"角度越大越激进"是错的，30→45 反而多花 1h27m。
别再让用户往上调。

## 三个坑

1. **预设带 `inherits`，命令行不解析。** 直接 `--load-settings "0.28mm Extra Draft @BBL X1C.json"`
   会拿到 0.2 层高、无支撑——因为那文件只有 51 个键，其余靠继承。必须先把继承链展平
   （`flatten_preset` 可查看展开结果和可用键名）。
2. **`--slice` 单独用不产出任何东西。** 必须 `--slice 0 --export-3mf out.3mf in.3mf`。
   单独用报的是"plate is empty"，跟盘无关，别被误导。
3. **覆盖值都是字符串**，布尔写 `"1"`/`"0"`。

## 没有 MCP 时的手工命令

```bash
# 1) 建工程（machine;process 用分号连接，filament 单独给）
bambu-studio --export-3mf out.3mf \
  --load-settings "machine.json;process.json" \
  --load-filaments "filament.json" model.stl

# 2) 切片
bambu-studio --slice 0 --export-3mf out.gcode.3mf out.3mf
```

`--load-settings` 里的两个 json 必须是**展平后**的，否则参数不生效。

## 排查

| 现象 | 原因 |
|---|---|
| 层高/支撑不生效 | 预设没展平，继承了默认值 |
| `plate is empty` | 只用了 `--slice`，没带导出参数 |
| 检测不到 slicer | 装在非 C 盘或绿色版，传 `slicer_path` 或设 `BAMBU_SLICER_BIN` |
| 切片超时 | 大模型单次几十秒正常，扫描多组记得放宽超时 |
