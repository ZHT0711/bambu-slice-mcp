/**
 * Driving the slicer CLI.
 *
 * Two separate operations are needed, and the order matters:
 *
 *   1. buildProject  model(.stl/.3mf) + presets  ->  project.3mf   (no gcode)
 *      bambu-studio --export-3mf out.3mf \
 *          --load-settings "machine.json;process.json" \
 *          --load-filaments filament.json  model.stl
 *
 *   2. sliceProject  project.3mf -> sliced .gcode.3mf
 *      bambu-studio --slice 0 --export-3mf out.3mf project.3mf
 *
 * `--slice` only produces output when combined with an export flag. Running
 * `--slice 0 --outputdir dir` on its own fails with the misleading
 * "One of the plate is empty or has no object fully inside it".
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import AdmZip from "adm-zip";
import { flattenPreset, resolvePreset } from "./profiles.js";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export function makeTempDir(prefix = "bambu-slice-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function runCli(bin, args, { timeoutMs = DEFAULT_TIMEOUT_MS, cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const msg =
            `slicer exited with ${error.code ?? error.signal}\n` +
            `args: ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}\n` +
            `${String(stderr || "").trim()}`;
          const e = new Error(msg);
          e.stdout = stdout;
          e.stderr = stderr;
          reject(e);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

/** Write flattened presets to a temp dir and return their paths. */
function materializePresets(slicer, { machine, process, filament }, tempDir) {
  const out = { machine: null, process: null, filament: null };
  const wanted = { machine, process, filament };
  for (const kind of ["machine", "process", "filament"]) {
    const spec = wanted[kind];
    if (!spec) continue;
    const flat = flattenPreset(slicer, spec, kind);
    const file = path.join(tempDir, `${kind}.json`);
    fs.writeFileSync(file, JSON.stringify(flat.config, null, 2), "utf-8");
    out[kind] = file;
  }
  return out;
}

/**
 * Build a project .3mf that carries the requested settings.
 * @returns {Promise<{output:string, presets:object, chains:object}>}
 */
export async function buildProject({
  slicer,
  input,
  output,
  machine,
  process,
  filament,
  overrides,
  timeoutMs,
}) {
  if (!fs.existsSync(input)) throw new Error(`Input not found: ${input}`);
  const tempDir = makeTempDir("bambu-preset-");
  try {
    const presetPaths = materializePresets(slicer, { machine, process, filament }, tempDir);

    // Per-run overrides are merged into the flattened process preset so the
    // slicer sees concrete values rather than another inheritance layer.
    let processPath = presetPaths.process;
    if (overrides && Object.keys(overrides).length) {
      const flat = process
        ? flattenPreset(slicer, process, "process")
        : { config: {} };
      const merged = { ...flat.config, ...stringifyValues(overrides) };
      processPath = path.join(tempDir, "process-overridden.json");
      fs.writeFileSync(processPath, JSON.stringify(merged, null, 2), "utf-8");
    }

    const args = ["--export-3mf", output];
    const settings = [presetPaths.machine, processPath].filter(Boolean);
    if (settings.length) args.push("--load-settings", settings.join(";"));
    if (presetPaths.filament) args.push("--load-filaments", presetPaths.filament);
    args.push(input);

    fs.mkdirSync(path.dirname(output), { recursive: true });
    await runCli(slicer.binary, args, { timeoutMs });
    if (!fs.existsSync(output)) {
      throw new Error(`Slicer did not write ${output}`);
    }

    const chains = {
      machine: machine ? flattenPreset(slicer, machine, "machine").chain : null,
      process: process ? flattenPreset(slicer, process, "process").chain : null,
      filament: filament ? flattenPreset(slicer, filament, "filament").chain : null,
    };
    return { output, presets: presetPaths, chains };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Slice a project .3mf into a print-ready .gcode.3mf */
export async function sliceProject({ slicer, input, output, timeoutMs }) {
  if (!fs.existsSync(input)) throw new Error(`Input not found: ${input}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await runCli(slicer.binary, ["--slice", "0", "--export-3mf", output, input], {
    timeoutMs,
  });
  if (!fs.existsSync(output)) {
    throw new Error(`Slicer did not write ${output}`);
  }
  return { output, info: readSliceInfo(output) };
}

function stringifyValues(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === "boolean" ? (v ? "1" : "0") : String(v);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Reading the result
 * ------------------------------------------------------------------ */

const META_RE = /key="([^"]+)"\s+value="([^"]*)"/g;

export function isSliced(file) {
  try {
    const zip = new AdmZip(file);
    return zip.getEntries().some((e) => /^Metadata\/plate_\d+\.gcode$/.test(e.entryName));
  } catch {
    return false;
  }
}

/**
 * Summarise a sliced .3mf: print time, filament, whether supports were used.
 * Returns null when the archive holds no slice info.
 */
export function readSliceInfo(file) {
  let zip;
  try {
    zip = new AdmZip(file);
  } catch (e) {
    throw new Error(`Not a readable 3mf: ${file} (${e.message})`);
  }
  const entry = zip.getEntry("Metadata/slice_info.config");
  if (!entry) return null;
  const xml = entry.getData().toString("utf-8");

  const meta = {};
  let m;
  META_RE.lastIndex = 0;
  while ((m = META_RE.exec(xml))) meta[m[1]] = m[2];

  const filaments = [];
  const FIL_RE = /<filament\b([^>]*)\/?>/g;
  while ((m = FIL_RE.exec(xml))) {
    const attrs = {};
    const ATTR_RE = /(\w+)="([^"]*)"/g;
    let a;
    while ((a = ATTR_RE.exec(m[1]))) attrs[a[1]] = a[2];
    if (attrs.used_g || attrs.used_m) filaments.push(attrs);
  }

  const gcodeEntries = zip
    .getEntries()
    .filter((e) => /^Metadata\/plate_\d+\.gcode$/.test(e.entryName));

  const seconds = Number(meta.prediction ?? 0) || 0;
  const grams = Number(meta.weight ?? filaments.reduce((s, f) => s + Number(f.used_g || 0), 0)) || 0;

  return {
    sliced: gcodeEntries.length > 0,
    predictionSeconds: seconds,
    humanTime: formatDuration(seconds),
    weightGrams: grams,
    supportUsed: meta.support_used === "true",
    outside: meta.outside === "true",
    layerNumber: meta.total_layer_number ? Number(meta.total_layer_number) : undefined,
    gcodeMb: gcodeEntries.reduce((s, e) => s + e.header.size, 0) / 1024 / 1024,
    plates: gcodeEntries.length,
    filaments,
    raw: meta,
  };
}

export function formatDuration(seconds) {
  if (!seconds) return "0m";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d${h % 24}h`;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

/**
 * Build + slice one configuration. Returns the paths plus the slice summary.
 */
export async function makeAndSlice({
  slicer,
  input,
  workDir,
  tag,
  machine,
  process,
  filament,
  overrides,
  timeoutMs,
  keepFiles = false,
}) {
  const project = path.join(workDir, `${tag}.3mf`);
  const sliced = path.join(workDir, `${tag}.gcode.3mf`);
  await buildProject({
    slicer,
    input,
    output: project,
    machine,
    process,
    filament,
    overrides,
    timeoutMs,
  });
  const { info } = await sliceProject({ slicer, input: project, output: sliced, timeoutMs });
  if (!keepFiles) {
    fs.rmSync(project, { force: true });
  }
  return { project, sliced, info };
}

export { resolvePreset };
