// Launch Radar's model: the sealed snapshot in, one ranked board out.
//
// The board ranks every launch candidate in the snapshot: a protocol that records no token and is
// not a wrapped, staked or bridged product of a token that already trades. The snapshot's own
// watchlist (40 protocols at or above the $50M floor) is always covered in full; the other 138
// candidates below the floor are the early rows the radar exists to find.
//
// Implied value is priced from comparables, never from a fixed multiple:
//
//   peer multiple  = the median market-cap-to-TVL ratio of the token-trading protocols in the
//                    candidate's own category (at least 3 peers required, else the global median
//                    over all peer protocols), clamped to [0.01, 2]
//   growth         = 1 + clamp(change_7d, -50, 100) / 100 x 0.5
//   maturity       = 0.7 + 0.3 x ln(1 + min(age_days, 1095)) / ln(1 + 1095)   (unknown age: 365)
//   chains         = 1 + 0.05 x min(chains beyond the first, 4)
//   implied        = round(tvl_usd x peer multiple x growth x maturity x chains)
//
// Every input is a figure the snapshot carries. No protocol name is ever special-cased: the same
// functions score every row, and the dashboard shows each row's working in full.

/** One protocol entry: exactly the ten fields the sealed snapshot carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  peer_min_count: number;
  multiple_floor: number;
  multiple_cap: number;
  growth_floor: number;
  growth_cap: number;
  growth_weight: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  chain_step: number;
  chain_max_extra: number;
}

export const MODEL: ModelConstants = {
  peer_min_count: 3,
  multiple_floor: 0.01,
  multiple_cap: 2,
  growth_floor: -50,
  growth_cap: 100,
  growth_weight: 0.5,
  maturity_floor: 0.7,
  maturity_range: 0.3,
  maturity_days: 1095,
  unknown_age_days: 365,
  chain_step: 0.05,
  chain_max_extra: 4,
};

/** The model's version label, shown on the dashboard. */
export const MODEL_VERSION = 'launch-radar-1';

/** How many representative peers a row's breakdown names. */
export const REPRESENTATIVE_PEERS = 5;

/** Categories whose protocols are wrapped, staked, bridged or exchange products, never launches. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Exchange names a wrapped product's name may begin with. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A whole word that marks a wrapped or staked product. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** A peer protocol: one whose market multiple the model can learn from. */
export interface Peer {
  slug: string;
  name: string;
  category: string | null;
  multiple: number;
}

/** A peer set: the median multiple of one category, or of every peer. */
export interface PeerSet {
  multiple: number;
  count: number;
  peers: Peer[];
}

/** Every peer set the snapshot yields. */
export interface PeerData {
  global: PeerSet;
  byCategory: Map<string, PeerSet>;
}

/** One comparable named in a row's breakdown. */
export interface Comparable {
  slug: string;
  name: string;
  multiple: number;
}

/** A row's valuation working, as the dashboard shows it. */
export interface Valuation {
  peer_multiple: number;
  peer_set: 'category' | 'global';
  peer_category: string | null;
  peer_count: number;
  growth_pct: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
  age_days: number | null;
  comparables: Comparable[];
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: Valuation;
  farm_steps: string[];
}

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  peer_summary: { global_multiple: number; global_peer_count: number; categories_priced: number; categories_fallback: number };
  watchlist_size: number;
  board_size: number;
  early_size: number;
  watchlist: string[];
  rows: BoardRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list, deterministically. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is a launch candidate: pre-token and not a wrapped, staked or bridged product. */
export function isLaunchCandidate(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED_NAME.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIXES.some((e) => p.name.startsWith(e))) return false;
  return true;
}

/** The peer protocols: token-trading, priced by the market, outside the excluded categories. */
function peerProtocols(snapshot: Snapshot): Peer[] {
  const peers: Peer[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) continue;
    peers.push({ slug: p.slug, name: p.name, category: p.category, multiple: p.mcap_usd / p.tvl_usd });
  }
  peers.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return peers;
}

/** Every peer set: the global median and one median per category with enough peers. */
export function peerSets(snapshot: Snapshot, model: ModelConstants = MODEL): PeerData {
  const peers = peerProtocols(snapshot);
  const global: PeerSet = { multiple: median(peers.map((p) => p.multiple)), count: peers.length, peers };
  const byCategory = new Map<string, PeerSet>();
  const grouped = new Map<string, Peer[]>();
  for (const p of peers) {
    if (p.category === null) continue;
    const list = grouped.get(p.category) ?? [];
    list.push(p);
    grouped.set(p.category, list);
  }
  for (const [category, list] of grouped) {
    if (list.length < model.peer_min_count) continue;
    byCategory.set(category, { multiple: median(list.map((p) => p.multiple)), count: list.length, peers: list });
  }
  return { global, byCategory };
}

/** The peers nearest a set's median multiple: the comparables a row's breakdown names. */
function representativePeers(set: PeerSet): Comparable[] {
  return [...set.peers]
    .sort((a, b) => Math.abs(a.multiple - set.multiple) - Math.abs(b.multiple - set.multiple) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, REPRESENTATIVE_PEERS)
    .map((p) => ({ slug: p.slug, name: p.name, multiple: round4(p.multiple) }));
}

/** The peer set a protocol is priced from: its category's when it has enough peers, else the global set. */
export function peerSetFor(p: SnapshotProtocol, data: PeerData): { set: PeerSet; kind: 'category' | 'global' } {
  if (p.category !== null) {
    const set = data.byCategory.get(p.category);
    if (set !== undefined) return { set, kind: 'category' };
  }
  return { set: data.global, kind: 'global' };
}

/** A protocol's implied value and its full working under the model. */
export function impliedValueOf(p: SnapshotProtocol, asOf: string, data: PeerData, model: ModelConstants = MODEL): { implied: number; valuation: Valuation } {
  const { set, kind } = peerSetFor(p, data);
  const peerMultiple = Math.min(model.multiple_cap, Math.max(model.multiple_floor, set.multiple));
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, p.change_7d ?? 0));
  const growthMultiplier = 1 + (growthPct / 100) * model.growth_weight;
  const age = ageDays(asOf, p.listed_at);
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMultiplier =
    model.maturity_floor + model.maturity_range * (Math.log(1 + Math.min(Math.max(ageForModel, 0), model.maturity_days)) / Math.log(1 + model.maturity_days));
  const chainMultiplier = 1 + model.chain_step * Math.min(Math.max(p.chains.length - 1, 0), model.chain_max_extra);
  const implied = Math.max(1, Math.min(100_000_000_000_000, Math.round(p.tvl_usd * peerMultiple * growthMultiplier * maturityMultiplier * chainMultiplier)));
  return {
    implied,
    valuation: {
      // Full precision: the dashboard recomputes the implied value from these factors and must
      // land on the same integer board.json carries. Display rounding happens in the page.
      peer_multiple: peerMultiple,
      peer_set: kind,
      peer_category: kind === 'category' ? p.category : null,
      peer_count: set.count,
      growth_pct: growthPct,
      growth_multiplier: growthMultiplier,
      maturity_multiplier: maturityMultiplier,
      chain_multiplier: chainMultiplier,
      age_days: age,
      comparables: representativePeers(set),
    },
  };
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** A step as one string: action, cost and time, within the gate's 20 to 600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep the position open and re-check the protocol's own page weekly.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The position size a farm step uses, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 2_000_000_000) return 200;
  if (p.tvl_usd >= 500_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 90) return 90;
  if (age < 365) return 60;
  return 30;
}

/** The category's main action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Lend $${capital} in stablecoins to ${name}'s ${chain} market and leave the deposit earning.`;
  if (c.includes('dex') || c.includes('leveraged farm') || c.includes('liquid')) return `Add $${capital} of paired liquidity to ${name}'s busiest ${chain} pool and hold the LP position.`;
  if (c.includes('bridge')) return `Move $${capital} across ${chain} with ${name}, then put the arrived funds to work in the destination app it points to.`;
  if (c.includes('stak') || c.includes('restak')) return `Stake $${capital} through ${name} on ${chain} and keep the receipt token in the same wallet.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Post $${capital} of margin on ${name}'s ${chain} market and open a single small hedged position.`;
  if (c.includes('prediction')) return `Fund ${name} with $${capital} on ${chain} and take one position in an active market.`;
  if (c.includes('stable')) return `Mint or hold $${capital} of ${name}'s stable asset on ${chain} through its own app.`;
  if (c.includes('rwa')) return `Buy $${capital} of ${name}'s tokenized asset on ${chain} and hold it in the farming wallet.`;
  if (c.includes('insurance')) return `Purchase $${capital} of cover through ${name} on ${chain} and keep the policy active.`;
  if (c.includes('yield') || c.includes('farm') || c.includes('aggregator') || c.includes('allocator') || c.includes('curator') || c.includes('index') || c.includes('basis'))
    return `Deposit $${capital} into ${name}'s highest-TVL ${chain} vault and leave the shares untouched.`;
  return `Put $${capital} to work in ${name}'s main ${chain} product and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived from
 * the protocol's own record (category, chains, TVL, age), never from a hand-written list of names.
 */
export function farmPlanFor(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  return [
    {
      text: 'Set aside a wallet used only for this farm, funded with no more than the position size below, and store its recovery phrase offline.',
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: 'Return once a week and make one qualifying action, such as a deposit, a swap, a vote or a claim.',
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Keep the position open for at least ${hold} days so the activity lands in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Open ${p.name}'s own points or rewards page from its official site before withdrawing, and claim only through the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: 'Log the wallet, the dates and every transaction, then unwind in reverse order when the farm ends.',
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The ranked board: every launch candidate, strongest implied value first, ranks 1 to N. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const data = peerSets(snapshot, model);
  const watchlist = new Set(snapshot.watchlist);
  const candidates = snapshot.protocols.filter((p) => isLaunchCandidate(p) || watchlist.has(p.slug));
  const scored = candidates.map((p) => {
    const { implied, valuation } = impliedValueOf(p, snapshot.as_of, data, model);
    return { p, implied, valuation };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.valuation.age_days,
    implied_value_usd: s.implied,
    model: s.valuation,
    farm_steps: farmPlanFor(s.p, s.valuation.age_days).map(stepText),
  }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const data = peerSets(snapshot, model);
  const priced = new Set(board.filter((r) => r.model.peer_set === 'category').map((r) => r.category));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    peer_summary: {
      global_multiple: round4(data.global.multiple),
      global_peer_count: data.global.count,
      categories_priced: priced.size,
      categories_fallback: new Set(board.map((r) => r.category)).size - priced.size,
    },
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !snapshot.watchlist.includes(r.slug)).length,
    watchlist: snapshot.watchlist,
    rows: board,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null. Mirrors the gate's own rows. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100 to 4000`;
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (const r of board) {
    if (!known.has(r.slug)) return `${r.slug} is not one of the snapshot's protocols`;
    if (seen.has(r.slug)) return `${r.slug} appears twice`;
    seen.add(r.slug);
  }
  const missing = snapshot.watchlist.filter((s) => !seen.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (typeof r.name !== 'string' || r.name.length === 0) return `${r.slug} has no name`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const trimmed = s.trim();
      if (trimmed.length < 20 || trimmed.length > 600) return `${r.slug} has a farm step of ${trimmed.length} characters`;
    }
  }
  return null;
}

/** The dashboard's dataset as one script: no fetch, no network, the same rows board.json carries. */
export function dataScript(radar: RadarData): string {
  return `window.LAUNCH_RADAR=${JSON.stringify(radar)};\n`;
}
