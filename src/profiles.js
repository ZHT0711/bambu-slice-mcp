/**
 * Locating Bambu Studio / OrcaSlicer and resolving their bundled presets.
 *
 * The tricky part this module solves: bundled presets are NOT flat. A file like
 * `0.28mm Extra Draft @BBL X1C.json` only contains a handful of keys and says
 * `"inherits": "fdm_process_single_0.28"`. The slicer GUI resolves that chain,
 * but the command line does not: any key the file does not spell out literally
 * falls back to the built-in default (layer_height 0.2, no support, ...).
 *
 * So before handing a preset to the CLI we walk `inherits` upwards and merge
 * parent -> child into one flat object.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const KINDS = ["machine", "process", "filament"];

const MAX_INHERIT_DEPTH = 16;

/* ------------------------------------------------------------------ *
 * Binary discovery
 * ------------------------------------------------------------------ */

function exists(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  }
}

function winCandidates() {
  const roots = [
    process.env.ProgramFiles || "C:\\Program Files",
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs") : null,
  ].filter(Boolean);
  const out = [];
  for (const r of roots) {
    out.push(path.join(r, "Bambu Studio", "bambu-studio.exe"));
    out.push(path.join(r, "OrcaSlicer", "orca-slicer.exe"));
    out.push(path.join(r, "OrcaSlicer", "OrcaSlicer.exe"));
    out.push(path.join(r, "Orca Slicer", "orca-slicer.exe"));
  }
  return out;
}

function macCandidates() {
  return [
    "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio",
    "/Applications/Bambu Studio.app/Contents/MacOS/BambuStudio",
    "/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer",
  ];
}

function linuxCandidates() {
  return [
    "/usr/bin/bambu-studio",
    "/usr/local/bin/bambu-studio",
    "/opt/bambu-studio/bin/bambu-studio",
    "/usr/bin/orca-slicer",
    "/usr/local/bin/orca-slicer",
    "/opt/orcaslicer/bin/orca-slicer",
    "/app/bin/orca-slicer",
  ];
}

function fromPath(names) {
  const finder = process.platform === "win32" ? "where" : "which";
  for (const n of names) {
    try {
      const out = execFileSync(finder, [n], { encoding: "utf-8", stdio: "pipe" })
        .split(/\r?\n/)[0]
        .trim();
      if (out && exists(out)) return out;
    } catch {
      /* not on PATH */
    }
  }
  return null;
}

/** Windows only: the slicer registers `ftype bambustudio=...`, which survives
 *  being installed on a drive other than C:. */
function winAssocCandidates() {
  const found = [];
  try {
    const dump = execFileSync("cmd", ["/c", "ftype"], {
      encoding: "utf-8",
      stdio: "pipe",
      windowsHide: true,
    });
    const re = /"([^"]*(?:bambu-studio|orca-slicer|OrcaSlicer)\.exe)"/gi;
    let m;
    while ((m = re.exec(dump))) found.push(m[1]);
  } catch {
    /* ftype unavailable */
  }
  return found;
}

/** Last resort: probe every fixed drive for a default install layout. */
function winDriveCandidates() {
  const out = [];
  const dirs = ["Bambu Studio", "OrcaSlicer", "Orca Slicer", "OrcaSlicer\\bin"];
  const exes = ["bambu-studio.exe", "orca-slicer.exe", "OrcaSlicer.exe"];
  for (let c = 67; c <= 90; c++) {
    const drive = String.fromCharCode(c) + ":\\";
    try {
      if (!fs.statSync(drive).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const sub of ["Program Files\\", "Program Files (x86)\\", ""]) {
      for (const d of dirs) {
        for (const e of exes) out.push(path.join(drive, sub, d, e));
      }
    }
  }
  return out;
}

function kindOf(bin) {
  return /orca/i.test(bin) ? "orca" : "bambu";
}

/* ------------------------------------------------------------------ *
 * Profile root discovery
 * ------------------------------------------------------------------ */

function profileRootCandidates(bin) {
  const dir = path.dirname(bin);
  const cands = [
    path.join(dir, "resources", "profiles"),
    path.join(dir, "..", "Resources", "profiles"), // macOS .app bundle
    path.join(dir, "..", "share", "bambu-studio", "resources", "profiles"),
    path.join(dir, "..", "..", "resources", "profiles"),
    "/usr/share/bambu-studio/resources/profiles",
    "/usr/share/orcaslicer/resources/profiles",
    "/usr/share/OrcaSlicer/resources/profiles",
  ];
  return cands.map((p) => path.resolve(p));
}

function vendorDirs(profilesRoot) {
  let entries;
  try {
    entries = fs.readdirSync(profilesRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(profilesRoot, e.name))
    .filter((p) => fs.existsSync(path.join(p, "process")) || fs.existsSync(path.join(p, "machine")));
}

/**
 * Resolve the slicer binary and its profile tree.
 * @param {string} [explicit] path to the slicer executable
 */
export function resolveSlicer(explicit) {
  const tried = [];

  const stages = [];
  const explicitStage = [];
  if (explicit) explicitStage.push(explicit);
  if (process.env.BAMBU_SLICER_BIN) explicitStage.push(process.env.BAMBU_SLICER_BIN);
  stages.push(explicitStage);

  if (process.platform === "win32") stages.push(winCandidates());
  else if (process.platform === "darwin") stages.push(macCandidates());
  else stages.push(linuxCandidates());

  if (process.platform === "win32") {
    stages.push(winAssocCandidates());
    stages.push(winDriveCandidates());
  }

  const onPath = fromPath([
    "bambu-studio",
    "bambu-studio.exe",
    "orca-slicer",
    "OrcaSlicer",
    "orca-slicer.exe",
  ]);
  if (onPath) stages.push([onPath]);

  let binary = null;
  for (const stage of stages) {
    for (const c of stage) {
      tried.push(c);
      if (exists(c)) {
        binary = c;
        break;
      }
    }
    if (binary) break;
  }

  if (!binary) {
    const err = new Error(
      "No slicer found. Install Bambu Studio or OrcaSlicer, or pass `slicer_path`, " +
        "or set BAMBU_SLICER_BIN.",
    );
    err.tried = tried;
    throw err;
  }

  const roots = profileRootCandidates(binary);
  let profilesRoot = null;
  let vendor = null;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const vendors = vendorDirs(root);
    if (!vendors.length) continue;
    const hasProcess = (v) => fs.existsSync(path.join(v, "process"));
    // Bambu Studio ships several vendor trees (Anker, Creality, ...). The BBL one
    // is the only one whose presets the Bambu CLI understands, so prefer it and
    // only fall back when it is missing.
    const chosen =
      vendors.find((v) => path.basename(v).toUpperCase() === "BBL" && hasProcess(v)) ||
      vendors.filter(hasProcess)[0] ||
      vendors[0];
    profilesRoot = root;
    vendor = chosen;
    break;
  }

  return {
    binary,
    kind: kindOf(binary),
    profilesRoot,
    vendor,
    vendorName: vendor ? path.basename(vendor) : null,
  };
}

/* ------------------------------------------------------------------ *
 * Preset listing / resolving
 * ------------------------------------------------------------------ */

function walkJson(dir, base = dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkJson(full, base, acc);
    else if (e.isFile() && e.name.toLowerCase().endsWith(".json")) {
      acc.push({
        name: path.basename(e.name, ".json"),
        relative: path.relative(base, full).replace(/\\/g, "/").replace(/\.json$/i, ""),
        path: full,
      });
    }
  }
  return acc;
}

export function listPresets(slicer, kind) {
  if (!slicer.vendor || !KINDS.includes(kind)) return [];
  return walkJson(path.join(slicer.vendor, kind)).sort((a, b) => a.relative.localeCompare(b.relative));
}

/** Find a preset by relative name, plain name, or absolute path. */
export function resolvePreset(slicer, kind, spec) {
  if (!spec) return null;
  if (fs.existsSync(spec) && fs.statSync(spec).isFile()) {
    return { name: path.basename(spec, ".json"), relative: spec, path: spec };
  }
  const wanted = spec.replace(/\\/g, "/").replace(/\.json$/i, "").toLowerCase();
  const all = listPresets(slicer, kind);
  const exactRel = all.find((p) => p.relative.toLowerCase() === wanted);
  if (exactRel) return exactRel;
  const exactName = all.filter((p) => p.name.toLowerCase() === wanted);
  if (exactName.length === 1) return exactName[0];
  if (exactName.length > 1) {
    // Prefer the shortest path (the generic, non printer-specific one).
    exactName.sort((a, b) => a.relative.length - b.relative.length);
    return exactName[0];
  }
  const fuzzy = all.filter((p) => p.relative.toLowerCase().includes(wanted));
  if (fuzzy.length === 1) return fuzzy[0];
  const err = new Error(
    fuzzy.length
      ? `Preset "${spec}" is ambiguous in ${kind}: ` +
        fuzzy.slice(0, 8).map((p) => p.relative).join(", ")
      : `Preset "${spec}" not found in ${kind}.`,
  );
  err.candidates = fuzzy.slice(0, 20).map((p) => p.relative);
  throw err;
}

/* ------------------------------------------------------------------ *
 * Inheritance flattening
 * ------------------------------------------------------------------ */

const flattenCache = new Map();

function rawJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function lookupByName(slicer, name) {
  for (const kind of KINDS) {
    try {
      const hit = resolvePreset(slicer, kind, name);
      if (hit) return hit;
    } catch {
      /* keep looking in the next kind */
    }
  }
  return null;
}

/**
 * Merge a preset with everything it inherits into a single flat object.
 * Returns { config, chain } where chain lists the files that were merged.
 */
export function flattenPreset(slicer, spec, kindHint) {
  const first =
    kindHint && !fs.existsSync(spec)
      ? resolvePreset(slicer, kindHint, spec)
      : fs.existsSync(spec)
        ? { path: spec, relative: spec }
        : resolvePreset(slicer, kindHint || "process", spec);
  if (!first) throw new Error(`Cannot resolve preset: ${spec}`);

  const cached = flattenCache.get(first.path);
  if (cached) return cached;

  const chain = [];
  const seen = new Set();

  const walk = (file, depth) => {
    if (seen.has(file) || depth > MAX_INHERIT_DEPTH) return {};
    seen.add(file);
    const raw = rawJson(file);
    let merged = {};
    const parent = raw.inherits;
    if (parent) {
      const found = lookupByName(slicer, parent);
      if (found) {
        merged = walk(found.path, depth + 1);
        chain.push(found.relative);
      } else if (process.env.BAMBU_SLICE_DEBUG) {
        process.stderr.write(`[bambu-slice] missing parent preset: ${parent}\n`);
      }
    }
    const { inherits, ...rest } = raw;
    merged = { ...merged, ...rest };
    return merged;
  };

  const config = walk(first.path, 0);
  const result = {
    config,
    chain: [...chain, first.relative],
    source: first.path,
    name: first.name || path.basename(first.path, ".json"),
  };
  flattenCache.set(first.path, result);
  return result;
}
