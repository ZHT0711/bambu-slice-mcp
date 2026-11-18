# bambu-slice-mcp

An MCP server that runs **Bambu Studio / OrcaSlicer's own slicing engine headlessly** and answers
"what does this setting actually cost me?" with sliced numbers instead of guesses.

It wraps the slicer CLI, so the gcode it produces is byte-for-byte what the GUI would produce for
the same profile — no reimplementation, no approximations.

```
generate → slice → measure → compare → keep the best
```

> **中文速览**
> 把拓竹 Studio / OrcaSlicer 自带的命令行包装成 MCP：不需要打开界面就能切片，并且能把某个参数
> （层高、支撑阈值、填充……）连续扫几组，实测每组要打多久、用多少料，直接给出排序表。
> 顺便解决两个坑：预设的 `inherits` 继承链命令行不认，以及 `--slice` 必须配 `--export-3mf`。
> 下文 *Gotchas* 一节有实测数据。

---

## Why this exists

Bambu Studio has no documented automation surface, and its CLI is under-documented. Two failures
waste a lot of time before anything works:

1. **Bundled presets are inheritance trees, and the CLI does not resolve them.**
   `0.28mm Extra Draft @BBL X1C.json` only contains 51 keys and says
   `"inherits": "fdm_process_single_0.28"`. Feed it to `--load-settings` and the slicer applies
   *only the literal keys*, silently falling back to built-in defaults — you ask for 0.28 mm layers
   and get 0.2 mm, ask for tree supports and get none.
2. **`--slice` produces nothing on its own.**
   `--slice 0 --outputdir out model.3mf` fails with
   `One of the plate is empty or has no object fully inside it`, which has nothing to do with the
   plate. The slicing step only emits output when paired with an export flag:
   `--slice 0 --export-3mf out.3mf model.3mf`.

`bambu-slice-mcp` handles both: it flattens the `inherits` chain up to 16 levels deep before calling
the CLI, and it always drives the two-step form (build project → slice project).

## Features

- **Headless slicing** of `.stl` / `.3mf` into print-ready `.gcode.3mf`
- **Preset inheritance flattened** — machine, process and filament chains resolved and merged
- **Measured sweeps** — vary one key over N values, get real print time and filament per variant
- **Per-run overrides** — any Bambu config key, merged onto the flattened process preset
- **Cross-platform discovery** — Windows (including non-`C:` installs via `ftype`), macOS `.app`
  bundles, Linux packages, `PATH`, or an explicit path
- **Works with OrcaSlicer too** — it ships the same `BBL` profile tree

## Requirements

- Node.js 18+
- Bambu Studio or OrcaSlicer installed locally (the profile tree must be present)

## Install

```bash
git clone https://github.com/ZHT0711/bambu-slice-mcp.git
cd bambu-slice-mcp
npm install
```

Register it with your MCP client.

**WorkBuddy / Claude Desktop / Cursor style (`mcpServers` JSON):**

```json
{
  "mcpServers": {
    "bambu-slice": {
      "command": "node",
      "args": ["/absolute/path/to/bambu-slice-mcp/src/server.js"]
    }
  }
}
```

On Windows the path looks like `"D:\\\\tools\\\\bambu-slice-mcp\\\\src\\\\server.js"`.

If the slicer is not auto-detected, set `BAMBU_SLICER_BIN`:

```json
{
  "mcpServers": {
    "bambu-slice": {
      "command": "node",
      "args": ["/path/to/src/server.js"],
      "env": { "BAMBU_SLICER_BIN": "D:\\Program Files\\Bambu Studio\\bambu-studio.exe" }
    }
  }
}
```

## Tools

| Tool | What it does |
| --- | --- |
| `detect_slicer` | Find the slicer, its profile tree, and how many presets it ships |
| `list_presets` | List/filter machine, process and filament presets |
| `build_project` | Model + presets + overrides → project `.3mf` (no gcode yet) |
| `slice_project` | Project `.3mf` → `.gcode.3mf`, returns time / filament / supports |
| `inspect_3mf` | Read a 3mf: already sliced? print time? selected settings? |
| `optimize` | Sweep one key over several values, build + slice each, rank by print time |
| `flatten_preset` | Show what a preset really resolves to (and which keys are available) |

### Example: what does the support threshold cost?

```jsonc
// optimize
{
  "input": "D:/models/elbow_half.stl",
  "sweep_param": "support_threshold_angle",
  "values": ["20", "25", "30", "35", "45", "55"],
  "machine": "Bambu Lab X1 Carbon 0.4 nozzle",
  "process": "0.28mm Extra Draft @BBL X1C",
  "filament": "Bambu PLA Basic @BBL X1C",
  "base_overrides": {
    "layer_height": "0.28",
    "wall_loops": "3",
    "sparse_infill_density": "10%",
    "sparse_infill_pattern": "gyroid",
    "enable_support": "1",
    "support_type": "tree(auto)",
    "support_on_build_plate_only": "1"
  }
}
```

Result on a 137 cm³ duct half (mirrored part, identical numbers for both halves):

| support_threshold_angle | print time | filament |
| --- | --- | --- |
| 20 | 6h15m | 185.1 g |
| 25 | 6h38m | 191.9 g |
| 30 | 7h14m | 202.4 g |
| 35 | 7h46m | 211.9 g |
| 45 | 8h41m | 229.7 g |
| 55 | 9h16m | 242.3 g |
| off | 4h13m | 152.1 g |

**Lower threshold = less support.** Going from 30° to 45° — the naive "steeper angle must mean more
aggressive" guess — costs 1h27m and 27 g per part. That is exactly the kind of assumption this tool
exists to replace with a measurement.

## Gotchas worth knowing

- **Preset inheritance**: pass `machine`, `process` and `filament` by their relative preset name as
  printed by `list_presets`, not by guessing a path. The server flattens whatever it resolves.
- **Overrides are strings**: `{"layer_height": "0.28"}`. Booleans are converted to `"1"`/`"0"`.
- **One plate at a time**: the CLI slices plate 1 (`--slice 0`).
- **Time is the slicer's prediction**, not a measured print.
- **Long calls**: slicing a big model takes tens of seconds; a sweep of six values can run for
  several minutes. Give the client a generous tool timeout.
- **`--load-filaments` is separate from `--load-settings`**; the process preset does not carry
  filament data.
- **Cold first layer (auto-patched)**: some shipped machine presets (BBL X1C in Studio 02.09)
  end their start gcode with `M109 S205;` — a preheat-only wait — and then draw the purge line,
  raising the nozzle target only at layer 2. The whole first layer prints ~40 °C low (PETG at 205,
  PLA at 180): under-extrusion and adhesion failures that never happen with GUI-sliced files,
  because the GUI's printer presets carry a full temperature choreography. The server detects this
  pattern in the flattened machine preset and rewrites the wait to
  `M109 S{nozzle_temperature_initial_layer[initial_no_support_extruder]}` before calling the CLI.
- **Bed type is a project setting, not a filament setting**: exported projects default to
  `Cool Plate`. PETG has no Cool Plate temperature, so slicing fails with
  "Filaments are not compatible with the plate type", and PLA prints with the bed at 35 °C.
  Pass `curr_bed_type` (e.g. `"Textured PEI Plate"`) as an override.
- **Paths must not contain spaces**: the CLI splits its arguments on spaces, so
  `C:\my models\part.stl` fails with "The input files to the slicer are not found". Chinese
  characters are fine; spaces are not.

## Development

```bash
npm test                                  # read-only smoke test over stdio
node test/e2e.js ./model.stl support_threshold_angle 25,30   # really slices
```

`bambu-slice-mcp` ships a `SKILL.md` as well, so agents that understand the skill format can pick
the right tool without reading this README.

## Not in scope

- Driving the slicer **GUI** (that needs computer control, not a CLI)
- Sending jobs to a printer (MQTT/FTPS) — see `schwarztim/bambu-mcp` for that
- Editing models, repairing meshes, arranging multiple objects

## License

MIT
