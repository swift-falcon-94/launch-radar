// Launch Radar's local gate mirror: checks an output directory against the competition's gate
// rules (board rows, dashboard files, screenshots, dossier bytes) without submitting anything.
//
//   node tools/validate.ts [out-dir] [--input <snapshot.json|directory>]

import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildDossier } from '../vendor/makefun-board.ts';

const failures: string[] = [];
const notes: string[] = [];
function check(ok: boolean, message: string): void {
  if (ok) notes.push(`ok: ${message}`);
  else failures.push(`FAIL: ${message}`);
}

function flag(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const joined = process.argv.find((a) => a.startsWith(`--${name}=`));
  return joined === undefined ? fallback : joined.slice(name.length + 3);
}

const out = process.argv[2] ?? 'out';
const inputArg = flag('input', '');
const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

// --- snapshot (for slug + coverage checks) ---
let snapshot: { protocols: { slug: string }[]; watchlist: string[] } | null = null;
if (inputArg !== '') {
  const file = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
  if (existsSync(file)) snapshot = JSON.parse(readFileSync(file, 'utf8')) as typeof snapshot;
}

// --- board.json ---
const boardPath = join(out, 'board.json');
check(existsSync(boardPath), 'board.json exists');
let rows: Record<string, unknown>[] = [];
if (existsSync(boardPath)) {
  check(statSync(boardPath).size <= 8 * 1024 * 1024, `board.json is ${statSync(boardPath).size} bytes, at most 8 MiB`);
  const parsed = JSON.parse(readFileSync(boardPath, 'utf8')) as unknown;
  rows = Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : ((parsed as { rows: Record<string, unknown>[] }).rows ?? []);
  check(Array.isArray(rows), 'board.json holds a rows array');
  check(rows.length >= 100 && rows.length <= 4000, `board holds ${rows.length} rows, within 100 to 4000`);
  const seen = new Set<string>();
  let ordered = true;
  let allEqual = rows.length >= 2;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (typeof r.slug !== 'string' || seen.has(r.slug)) check(false, `row ${i + 1} has a duplicate or missing slug`);
    seen.add(r.slug as string);
    if (typeof r.name !== 'string' || r.name.length === 0) check(false, `row ${i + 1} has no name`);
    if (r.rank !== i + 1) check(false, `row ${i + 1} carries rank ${String(r.rank)}`);
    const v = r.implied_value_usd;
    if (!Number.isSafeInteger(v) || (v as number) <= 0 || (v as number) > 100_000_000_000_000) check(false, `${String(r.slug)} has implied value ${String(v)}`);
    if (i > 0 && (v as number) > (rows[i - 1]!.implied_value_usd as number)) ordered = false;
    if (i > 0 && v !== rows[0]!.implied_value_usd) allEqual = false;
    const steps = r.farm_steps;
    if (!Array.isArray(steps) || steps.length < 3 || steps.length > 12) check(false, `${String(r.slug)} has ${Array.isArray(steps) ? steps.length : 'no'} farm steps`);
    else {
      for (const s of steps) {
        const t = String(s).trim();
        if (t.length < 20 || t.length > 600) check(false, `${String(r.slug)} has a farm step of ${t.length} characters`);
      }
    }
  }
  check(ordered, 'implied value does not rise as rank ascends');
  check(!allEqual, 'not every row shares one implied value');
  if (snapshot !== null) {
    const known = new Set(snapshot.protocols.map((p) => p.slug));
    check(rows.every((r) => known.has(r.slug as string)), 'every row slug is one of the snapshot protocols');
    const missing = snapshot.watchlist.filter((s) => !seen.has(s));
    check(missing.length === 0, `watchlist coverage: ${snapshot.watchlist.length - missing.length}/${snapshot.watchlist.length}`);
  }
}

// --- dashboard/ ---
const dashDir = join(out, 'dashboard');
check(existsSync(join(dashDir, 'index.html')), 'dashboard/index.html exists');
if (existsSync(dashDir)) {
  const names = readdirSync(dashDir).filter((n) => !n.startsWith('.'));
  let bytes = 0;
  let hasCss = false;
  let hasJs = false;
  let clean = true;
  for (const n of names) {
    const p = join(dashDir, n);
    if (!lstatSync(p).isFile()) { check(false, `dashboard/${n} is not a plain file`); continue; }
    if (!PLAIN_NAME.test(n)) check(false, `dashboard/${n} has a name the gate refuses`);
    const size = statSync(p).size;
    bytes += size;
    if (n.endsWith('.css')) hasCss = true;
    if (n.endsWith('.js')) hasJs = true;
    const text = readFileSync(p, 'utf8');
    if (text.includes('http://') || text.includes('https://')) { clean = false; check(false, `dashboard/${n} carries a network address`); }
  }
  check(names.length <= 400, `dashboard holds ${names.length} files, at most 400`);
  check(bytes <= 4 * 1024 * 1024, `dashboard is ${bytes} bytes, at most 4 MiB`);
  check(hasCss && hasJs, 'dashboard holds at least one .css and one .js file');
  check(clean, 'no dashboard file carries a network address');
  check(bytes <= 65_536, `dashboard source is ${bytes} bytes, within the 64 KiB the judge reads whole`);
}

// --- screenshots/ ---
function pngSize(buf: Buffer): [number, number] | null {
  if (buf.length < 24) return null;
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}
function jpegSize(buf: Buffer): [number, number] | null {
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) return null;
    const marker = buf[off + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
    const len = buf.readUInt16BE(off + 2);
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return [buf.readUInt16BE(off + 7), buf.readUInt16BE(off + 5)];
    }
    off += 2 + len;
  }
  return null;
}
const shotsDir = join(out, 'screenshots');
check(existsSync(shotsDir), 'screenshots/ exists');
if (existsSync(shotsDir)) {
  const shots = readdirSync(shotsDir).filter((n) => !n.startsWith('.')).sort();
  check(shots.length >= 3 && shots.length <= 4, `screenshots/ holds ${shots.length} images, within 3 to 4`);
  for (const n of shots) {
    const buf = readFileSync(join(shotsDir, n));
    check(buf.length <= 524_288, `screenshots/${n} is ${buf.length} bytes, at most 512 KiB`);
    const isPng = buf[0] === 0x89 && buf[1] === 0x50;
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
    check(isPng || isJpeg, `screenshots/${n} is a whole PNG or JPEG`);
    const dims = isPng ? pngSize(buf) : isJpeg ? jpegSize(buf) : null;
    if (dims === null) check(false, `screenshots/${n} dimensions unreadable`);
    else {
      const [w, h] = dims;
      check(Math.max(w, h) <= 1440, `screenshots/${n} long side is ${Math.max(w, h)} px, at most 1440`);
      check(Math.min(w, h) >= 800, `screenshots/${n} short side is ${Math.min(w, h)} px, at least 800`);
    }
  }
}

// --- dossier.json ---
const dossierPath = join(out, 'dossier.json');
check(existsSync(dossierPath), 'dossier.json exists');
if (existsSync(dossierPath)) {
  check(statSync(dossierPath).size <= 1_572_864, `dossier.json is ${statSync(dossierPath).size} bytes, at most 1.5 MiB`);
  try {
    const rebuilt = buildDossier(out, { text_max_bytes: 65_536, screenshots: { max: 4, max_bytes: 524_288 }, dashboard: { max_files: 400, max_bytes: 4_194_304 } });
    const current = readFileSync(dossierPath);
    check(Buffer.compare(Buffer.from(rebuilt), current) === 0, 'dossier.json equals what buildDossier writes');
  } catch (err) {
    check(false, `buildDossier refuses this output: ${err instanceof Error ? err.message : String(err)}`);
  }
}

for (const n of notes) process.stdout.write(`${n}\n`);
for (const f of failures) process.stderr.write(`${f}\n`);
process.stdout.write(failures.length === 0 ? `validate: PASS (${notes.length} checks)\n` : `validate: ${failures.length} FAILURE(S)\n`);
process.exit(failures.length === 0 ? 0 : 1);
