#!/usr/bin/env node
/**
 * bambu-slice-mcp — headless slicing + profile optimisation for
 * Bambu Studio / OrcaSlicer, exposed over the Model Context Protocol.
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { resolveSlicer, listPresets, flattenPreset } from "./profiles.js";
import { buildProject, sliceProject, readSliceInfo, isSliced, makeTempDir } from "./slicer.js";

const VERSION = "0.1.0";

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function json(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(err) {
  const lines = [err?.message || String(err)];
  if (err?.candidates?.length) {
    lines.push("", "Candidates:", ...err.candidates.map((c) => `  - ${c}`));
  }
  if (err?.tried?.length) {
    lines.push("", "Looked for the slicer at:", ...err.tried.map((c) => `  - ${c}`));
  }
  return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
}

function slicerInfo(s) {
  return {
    binary: s.binary,
    flavor: s.kind,
    profilesRoot: s.profilesRoot,
    vendor: s.vendorName,
    counts: {
      machine: s.vendor ? listPresets(s, "machine").length : 0,
      process: s.vendor ? listPresets(s, "process").length : 0,
      filament: s.vendor ? listPresets(s, "filament").length : 0,
    },
  };
}

/* ------------------------------------------------------------------ *
 * server
 * ------------------------------------------------------------------ */

const server = new McpServer({ name: "bambu-slice-mcp", version: VERSION });

server.registerTool(
  "detect_slicer",
  {
    title: "Detect slicer installation",
    description:
      "Locate Bambu Studio or OrcaSlicer on this machine and report the profile tree it ships with " +
      "(how many machine / process / filament presets). Run this first.",
    inputSchema: {
      slicer_path: z.string().optional().describe("Explicit path to the slicer executable"),
    },
  },
  async ({ slicer_path }) => {
    try {
      const slicer = resolveSlicer(slicer_path);
      return json(slicerInfo(slicer));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_presets",
  {
    title: "List available presets",
    description:
      "List bundled machine / process / filament presets. Use the returned `relative` name when " +
      "calling build_project or optimize.",
    inputSchema: {
      kind: z.enum(["machine", "process", "filament"]).describe("Preset category"),
      query: z.string().optional().describe("Case-insensitive substring filter, e.g. 'X1C' or '0.28'"),
      limit: z.number().int().min(1).max(500).default(60),
      slicer_path: z.string().optional(),
    },
  },
  async ({ kind, query, limit, slicer_path }) => {
    try {
      const slicer = resolveSlicer(slicer_path);
      let items = listPresets(slicer, kind);
      if (query) {
        const q = query.toLowerCase();
        items = items.filter((p) => p.relative.toLowerCase().includes(q));
      }
      return json({
        kind,
        total: items.length,
        returned: Math.min(items.length, limit),
        presets: items.slice(0, limit).map((p) => p.relative),
        hint:
          kind === "filament"
            ? "Filament presets often live in per-printer subfolders; the `relative` path is what you pass back."
            : undefined,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "build_project",
  {
    title: "Build a project .3mf with chosen settings",
    description:
      "Import a model (.stl or .3mf) and write a Bambu project .3mf that carries the requested " +
      "machine / process / filament presets plus optional per-run overrides. Preset inheritance is " +
      "flattened first, because the CLI ignores `inherits` and silently falls back to defaults.",
    inputSchema: {
      input: z.string().describe("Path to .stl or .3mf"),
      output: z.string().optional().describe("Output .3mf path (default: alongside the input)"),
      machine: z.string().optional().describe("Machine preset name or absolute .json path"),
      process: z.string().optional().describe("Process preset name or absolute .json path"),
      filament: z.string().optional().describe("Filament preset name or absolute .json path"),
      overrides: z
        .record(z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe('Raw Bambu config keys, e.g. {"layer_height":"0.28","enable_support":"1"}'),
      slicer_path: z.string().optional(),
    },
  },
  async ({ input, output, machine, process, filament, overrides, slicer_path }) => {
    try {
      const slicer = resolveSlicer(slicer_path);
      const target =
        output || path.join(path.dirname(input), `${path.basename(input, path.extname(input))}_project.3mf`);
      const res = await buildProject({
        slicer,
        input,
        output: target,
        machine,
        process,
        filament,
        overrides,
      });
      const info = readSliceInfo(target);
      return json({
        output: res.output,
        sizeMb: fs.statSync(res.output).size / 1024 / 1024,
        alreadySliced: Boolean(info?.sliced),
        resolved: res.chains,
        note: machine
          ? undefined
          : "No machine preset given — the slicer used its own default printer.",
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "slice_project",
  {
    title: "Slice a project .3mf",
    description:
      "Run the actual slicing step on a project .3mf and report predicted print time, filament " +
      "usage, support usage and gcode size.",
    inputSchema: {
      input: z.string().describe("Project .3mf (not yet sliced)"),
      output: z.string().optional().describe("Output .gcode.3mf path"),
      timeout_seconds: z.number().int().min(10).max(7200).default(900),
      slicer_path: z.string().optional(),
    },
  },
  async ({ input, output, timeout_seconds, slicer_path }) => {
    try {
      const slicer = resolveSlicer(slicer_path);
      if (isSliced(input)) {
        return json({ skipped: true, reason: "input already contains gcode", info: readSliceInfo(input) });
      }
      const target =
        output || input.replace(/\.3mf$/i, "") + "_sliced.gcode.3mf";
      const { info } = await sliceProject({
        slicer,
        input,
        output: target,
        timeoutMs: timeout_seconds * 1000,
      });
      return json({
        output: target,
        sizeMb: fs.statSync(target).size / 1024 / 1024,
        printTime: info?.humanTime,
        printTimeSeconds: info?.predictionSeconds,
        filamentGrams: info?.weightGrams,
        supportsUsed: info?.supportUsed,
        layers: info?.layerNumber,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "inspect_3mf",
  {
    title: "Inspect a 3mf",
    description:
      "Read a 3mf without slicing it: report whether it already contains gcode, and if so the " +
      "predicted print time, filament weight and settings highlights.",
    inputSchema: {
      input: z.string().describe("Path to a .3mf"),
      settings: z
        .array(z.string())
        .optional()
        .describe("Config keys to echo back, e.g. ['layer_height','support_threshold_angle']"),
    },
  },
  async ({ input, settings }) => {
    try {
      if (!fs.existsSync(input)) throw new Error(`Not found: ${input}`);
      const info = readSliceInfo(input);
      const out = {
        file: input,
        sizeMb: fs.statSync(input).size / 1024 / 1024,
        sliced: Boolean(info?.sliced),
        printTime: info?.humanTime,
        filamentGrams: info?.weightGrams,
        supportsUsed: info?.supportUsed,
      };
      if (settings?.length) {
        const { default: AdmZip } = await import("adm-zip");
        const zip = new AdmZip(input);
        const entry = zip.getEntry("Metadata/project_settings.config");
        if (entry) {
          const cfg = JSON.parse(entry.getData().toString("utf-8"));
          out.settings = Object.fromEntries(settings.map((k) => [k, cfg[k] ?? null]));
        }
      }
      return json(out);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "optimize",
  {
    title: "Sweep one parameter and compare real results",
    description:
      "Build and actually slice the same model once per value of a single config key, then return a " +
      "table of measured print time and filament usage sorted fastest first. This answers questions " +
      "like 'how much time does support_threshold_angle cost me?' with sliced numbers instead of guesses.",
    inputSchema: {
      input: z.string().describe("Path to .stl or .3mf"),
      sweep_param: z.string().describe("Config key to vary, e.g. support_threshold_angle, layer_height"),
      values: z.array(z.union([z.string(), z.number()])).min(1).max(12).describe("Values to try"),
      machine: z.string().optional(),
      process: z.string().optional(),
      filament: z.string().optional(),
      base_overrides: z
        .record(z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe("Overrides applied to every run"),
      output_dir: z
        .string()
        .optional()
        .describe(
          "Where to save sliced output. Default: <input dir>/bambu_sweep, keeping only the best run. " +
            "When set explicitly, every successful run is kept.",
        ),
      timeout_seconds: z.number().int().min(30).max(7200).default(900),
    },
  },
  async ({
    input,
    sweep_param,
    values,
    machine,
    process,
    filament,
    base_overrides,
    output_dir,
    timeout_seconds,
  }) => {
    const slicer = (() => {
      try {
        return resolveSlicer();
      } catch (e) {
        return null;
      }
    })();
    if (!slicer) return fail(new Error("No slicer found; set BAMBU_SLICER_BIN or install Bambu Studio."));
    if (!fs.existsSync(input)) return fail(new Error(`Not found: ${input}`));

    const workDir = makeTempDir("bambu-sweep-");
    const rows = [];
    try {
      for (const value of values) {
        const tag = `${sweep_param}-${String(value).replace(/[^\w.%-]/g, "_")}`;
        try {
          const project = path.join(workDir, `${tag}.3mf`);
          const sliced = path.join(workDir, `${tag}.gcode.3mf`);
          await buildProject({
            slicer,
            input,
            output: project,
            machine,
            process,
            filament,
            overrides: { ...(base_overrides || {}), [sweep_param]: value },
          });
          const { info } = await sliceProject({
            slicer,
            input: project,
            output: sliced,
            timeoutMs: timeout_seconds * 1000,
          });
          rows.push({
            value: String(value),
            ok: true,
            seconds: info?.predictionSeconds ?? 0,
            human: info?.humanTime ?? "?",
            grams: info?.weightGrams ?? 0,
            supports: info?.supportUsed ?? false,
            file: sliced,
          });
          fs.rmSync(project, { force: true });
        } catch (e) {
          rows.push({ value: String(value), ok: false, error: e.message.split("\n")[0] });
        }
      }

      const ok = rows.filter((r) => r.ok).sort((a, b) => a.seconds - b.seconds);
      const best = ok[0];

      // The working directory is deleted in `finally`, so anything worth keeping
      // has to be copied out first.
      if (ok.length) {
        const destDir = output_dir
          ? path.resolve(output_dir)
          : path.join(path.dirname(path.resolve(input)), "bambu_sweep");
        fs.mkdirSync(destDir, { recursive: true });
        const stem = path.basename(input, path.extname(input));
        const copyOut = (row) => {
          const dest = path.join(destDir, `${stem}_${sweep_param}-${row.value}.gcode.3mf`);
          fs.copyFileSync(row.file, dest);
          row.savedAs = dest;
        };
        if (best) copyOut(best);
        if (output_dir) ok.slice(1).forEach(copyOut); // explicit dir: keep every run
        if (best) best.savedDir = destDir;
      }

      const table = [
        `| ${sweep_param} | print time | filament | supports |`,
        `| --- | --- | --- | --- |`,
        ...rows
          .filter((r) => r.ok)
          .map((r) => `| ${r.value} | ${r.human} | ${r.grams.toFixed(1)} g | ${r.supports ? "yes" : "no"} |`),
      ].join("\n");

      const failed = rows.filter((r) => !r.ok);
      return json({
        sweep_param,
        baseline_note:
          "Sliced with the given presets; time and weight are the slicer's own prediction values.",
        table,
        best,
        failed: failed.length ? failed : undefined,
        results: rows.map(({ file, ...rest }) => rest),
      });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  },
);

server.registerTool(
  "flatten_preset",
  {
    title: "Flatten a preset's inheritance chain",
    description:
      "Show what a bundled preset actually resolves to. Useful when the CLI output ignores a value " +
      "you set in the GUI, or to discover the full key list available for overrides.",
    inputSchema: {
      name: z.string().describe("Preset relative name or absolute .json path"),
      kind: z.enum(["machine", "process", "filament"]).default("process"),
      only_keys: z.boolean().default(true).describe("Return key names instead of the whole config"),
    },
  },
  async ({ name, kind, only_keys }) => {
    try {
      const slicer = resolveSlicer();
      const flat = flattenPreset(slicer, name, kind);
      return json({
        source: flat.source,
        chain: flat.chain,
        keyCount: Object.keys(flat.config).length,
        keys: only_keys ? Object.keys(flat.config).sort() : undefined,
        config: only_keys ? undefined : flat.config,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

/* ------------------------------------------------------------------ *
 * boot
 * ------------------------------------------------------------------ */

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`bambu-slice-mcp ${VERSION} ready (cwd ${process.cwd()}, tmp ${os.tmpdir()})\n`);
