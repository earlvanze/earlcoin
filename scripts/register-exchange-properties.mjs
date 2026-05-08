#!/usr/bin/env node
/**
 * Register Lofty properties in the In-Kind Exchange contract.
 *
 * Modes:
 *   --portfolio    Register all W1 + Treasury properties that have LP pools
 *   --criteria     Register properties matching investment criteria (>30% alpha + cashflow, or >9% T-12 yield)
 *   --asa <id>     Register a single ASA
 *   --lofty-deals  Register ASAs represented by the current /lofty-deals shortlists
 *   --dry-run      Show what would be registered without executing
 *
 * Requires: GOV_ADMIN_MNEMONIC in environment
 * Cost: ~0.108 ALGO per property (MBR for box + ASA opt-in + fees)
 */

import algosdk from 'algosdk';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

function loadDotEnv(path) {
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim().replace(/^['\"]|['\"]$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

loadDotEnv('.env.local');

const ALGOD_URL = process.env.ALGOD_URL || 'https://mainnet-api.4160.nodely.dev';
const APP_ID = Number(process.env.INKIND_EXCHANGE_APP_ID || process.env.VITE_INKIND_EXCHANGE_APP_ID || '3518922796');
const EARL_ASA_ID = 3497993904;
const LP_API = 'https://lp.lofty.ai/prod/liquidity/v1/marketplace';
const LOFTYASSIST_API = 'https://app.earlco.in/api/lofty.php';
const W1 = 'YILY2YPFH2HODAZSMVJ6C2URUTBJSEPB3377SIKHFCFMGQEEFAJ3E5TYDM';
const TREASURY = 'EARLNMGRC6FCNRHRZGKRMU3ILJJE5ONNPBGIFQ5GLIZIL3BTAGNIQ5ZBEE';

const algod = new algosdk.Algodv2('', ALGOD_URL, '');
const mnemonic = (process.env.GOV_ADMIN_MNEMONIC || '').trim().replace(/\s+/g, ' ');
if (!mnemonic) { console.error('GOV_ADMIN_MNEMONIC required'); process.exit(1); }
const deployer = algosdk.mnemonicToSecretKey(mnemonic);
const deployerAddr = typeof deployer.addr === 'string' ? deployer.addr : algosdk.encodeAddress(deployer.addr.publicKey);
const appAddr = algosdk.getApplicationAddress(APP_ID);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const mode = args.includes('--lofty-deals') ? 'lofty-deals' : args.includes('--portfolio') ? 'portfolio' : args.includes('--criteria') ? 'criteria' : args.includes('--asa') ? 'single' : 'portfolio';

async function fetchLpPools() {
  const res = await fetch(LP_API, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' } });
  const data = await res.json();
  const pools = data?.data?.pools || [];
  const map = {};
  for (const p of pools) {
    const asaId = p.property?.assetId || p.assets?.base?.id;
    if (asaId && p.apps?.contracts?.admin && p.apps?.contracts?.lpInterface) {
      map[asaId] = {
        admin: p.apps.contracts.admin,
        lp: p.apps.contracts.lpInterface,
        name: p.property?.address_line1 || '?',
        price: p.price,
      };
    }
  }
  return map;
}


const normalizeAddressLookupKey = (value) => {
  if (!value) return '';
  const [street = '', city = ''] = String(value).split(',').map((part) => part.trim()).slice(0, 2);
  return `${street} ${city}`.toLowerCase().replace(/\./g, '').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
};

function buildAssistLookup(items) {
  const byAddressKey = {};
  const byAssetId = {};
  for (const item of items) {
    const prop = item.property || {};
    const contracts = item.liquidityPool?.apps?.contracts || item.liquidityPool?.contracts || {};
    const meta = {
      property_id: prop.id || prop.slug || null,
      slug: prop.slug || null,
      address: prop.address || null,
      city: prop.market || prop.city || null,
      state: prop.state || null,
      assetId: prop.assetId || null,
      newAssetId: prop.newAssetId || null,
      listingStatus: prop.listingStatus || null,
      coc: typeof prop.coc === 'number' ? prop.coc / 100 : 0,
      tokenValue: prop.tokenValue ?? null,
      contracts,
      price: item.liquidityPool?.price || item.liquidityPool?.priceLow || prop.tokenValue || null,
    };
    const key = normalizeAddressLookupKey(prop.address);
    if (key) byAddressKey[key] = meta;
    for (const id of [prop.assetId, prop.newAssetId].filter(Boolean)) byAssetId[Number(id)] = meta;
  }
  return { byAddressKey, byAssetId };
}

function buildMarketplaceIdSet(properties) {
  const ids = new Set();
  for (const prop of properties || []) for (const id of [prop.assetId, prop.newAssetId].filter(Boolean)) ids.add(String(id));
  return ids;
}

function attachAssistMeta(item, lookup) {
  if (item.assetId && lookup.byAssetId[Number(item.assetId)]) return { ...item, ...lookup.byAssetId[Number(item.assetId)] };
  const match = lookup.byAddressKey[normalizeAddressLookupKey(item.address || item.scenario || '')];
  return match ? { ...item, ...match } : item;
}

function isMarketplaceTradable(deal, marketplaceIds) {
  return [deal.assetId, deal.newAssetId]
    .filter((id) => id !== null && id !== undefined && id !== '')
    .map(String)
    .some((id) => marketplaceIds.has(id));
}

function getBestStrategyReturn(deal) {
  return Math.max(deal.quote_return || Number.NEGATIVE_INFINITY, deal.base_return || Number.NEGATIVE_INFINITY, deal.hybrid_return || Number.NEGATIVE_INFINITY);
}

function addDealTarget(targets, deal, source, lookup) {
  const meta = lookup.byAssetId[Number(deal.assetId)] || lookup.byAssetId[Number(deal.newAssetId)] || lookup.byAddressKey[normalizeAddressLookupKey(deal.address || deal.scenario || '')] || deal;
  const contracts = meta.contracts || {};
  const admin = contracts.admin || meta.admin;
  const lp = contracts.lpInterface || meta.lp;
  if (!admin || !lp) return;
  for (const asaId of [meta.assetId, meta.newAssetId, deal.assetId, deal.newAssetId].filter(Boolean).map(Number)) {
    if (!targets.has(asaId)) targets.set(asaId, { asaId, admin, lp, name: meta.address || deal.address || deal.scenario || '?', price: meta.price || meta.tokenValue || deal.market_price || null, source });
  }
}

async function getLoftyDealsTargets() {
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are required for --lofty-deals');
  const supabase = createClient(supabaseUrl, supabaseKey);

  const [{ data: alphaRows, error: alphaErr }, assistItems, marketplaceRaw] = await Promise.all([
    supabase.from('lofty_alpha_opportunities').select('*'),
    fetch(LOFTYASSIST_API).then((r) => r.json()),
    fetch('https://api.lofty.ai/prod/properties/v2/marketplace').then((r) => r.json()),
  ]);
  if (alphaErr) throw alphaErr;

  const lookup = buildAssistLookup(assistItems || []);
  const marketplaceProperties = marketplaceRaw?.data?.properties || marketplaceRaw?.properties || [];
  const marketplaceIds = buildMarketplaceIdSet(marketplaceProperties);
  const targets = new Map();

  const alphaDeals = (alphaRows || []).map((row) => attachAssistMeta(row, lookup)).filter((deal) => isMarketplaceTradable(deal, marketplaceIds)).sort((a, b) => {
    const rankA = typeof a.proposal_rank === 'number' ? a.proposal_rank : Number.POSITIVE_INFINITY;
    const rankB = typeof b.proposal_rank === 'number' ? b.proposal_rank : Number.POSITIVE_INFINITY;
    if (rankA !== rankB) return rankA - rankB;
    const navA = typeof a.nav_per_token === 'number' ? a.nav_per_token : 0;
    const navB = typeof b.nav_per_token === 'number' ? b.nav_per_token : 0;
    const marketA = typeof a.market_price === 'number' ? a.market_price : (typeof a.tokenValue === 'number' ? a.tokenValue : 0);
    const marketB = typeof b.market_price === 'number' ? b.market_price : (typeof b.tokenValue === 'number' ? b.tokenValue : 0);
    const alphaA = marketA > 0 ? ((navA - marketA) / marketA) : Number.NEGATIVE_INFINITY;
    const alphaB = marketB > 0 ? ((navB - marketB) / marketB) : Number.NEGATIVE_INFINITY;
    return alphaB - alphaA;
  }).slice(0, 20);
  alphaDeals.forEach((deal) => addDealTarget(targets, deal, 'alpha', lookup));

  const cashflowDeals = (assistItems || []).map((item) => {
    const prop = item.property || {};
    return { property_id: prop.id || prop.slug || prop.assetId, assetId: prop.assetId || null, newAssetId: prop.newAssetId || null, address: prop.address || 'Unknown property', city: prop.market || prop.city || null, state: prop.state || null, market_price: prop.tokenValue ?? null, coc: typeof prop.coc === 'number' ? prop.coc / 100 : 0, listingStatus: prop.listingStatus || null };
  }).filter((deal) => deal.listingStatus === 'Active' && isMarketplaceTradable(deal, marketplaceIds)).filter((deal) => typeof deal.coc === 'number' && deal.coc > 0).sort((a, b) => (b.coc || 0) - (a.coc || 0)).slice(0, 20);
  cashflowDeals.forEach((deal) => addDealTarget(targets, deal, 'cashflow', lookup));

  const strategyDeals = marketplaceProperties.map((prop) => {
    const priceLow = Number(prop.liquidity?.marketPrice?.priceLow || 0);
    const quoteReturn = Number(prop.liquidity?.stats?.apy7d?.quote || 0) / 100;
    const baseReturn = Number(prop.liquidity?.stats?.apy7d?.base || 0) / 100;
    return { assetId: prop.assetId || null, newAssetId: prop.newAssetId || null, address: prop.address || [prop.address_line1, prop.address_line2].filter(Boolean).join(', '), market_price: priceLow || null, quote_return: quoteReturn, base_return: baseReturn, hybrid_return: (quoteReturn + baseReturn) / 2 };
  }).filter((deal) => getBestStrategyReturn(deal) > 0).sort((a, b) => getBestStrategyReturn(b) - getBestStrategyReturn(a)).slice(0, 20);
  strategyDeals.forEach((deal) => addDealTarget(targets, deal, 'strategy', lookup));

  console.log(`LoftyDeals shortlist rows: alpha=${alphaDeals.length} cashflow=${cashflowDeals.length} strategy=${strategyDeals.length}`);
  return targets;
}

async function getPortfolioAsas() {
  const asas = new Set();
  for (const addr of [W1, TREASURY]) {
    const info = await algod.accountInformation(addr).do();
    for (const a of (info.assets || [])) {
      if (a.amount > 0 && a['asset-id'] !== EARL_ASA_ID && a['asset-id'] !== 31566704) {
        asas.add(a['asset-id']);
      }
    }
  }
  return asas;
}

async function getCriteriaAsas(poolMap) {
  const res = await fetch(LOFTYASSIST_API);
  const data = await res.json();
  const asas = new Set();
  for (const item of data) {
    const p = item.property || {};
    const asaId = p.assetId;
    if (!asaId || !poolMap[asaId]) continue;

    const coc = typeof item.coc === 'number' ? item.coc : (typeof p.coc === 'number' ? p.coc / 100 : 0);
    const nav = item.oraclePrice || p.tokenValue;
    const market = item.marketPrice || poolMap[asaId]?.price;
    const alpha = nav && market && market > 0 ? ((nav - market) / market * 100) : 0;

    if ((alpha > 30 && coc > 0) || coc > 9) {
      asas.add(asaId);
    }
  }
  return asas;
}

async function getRegisteredAsas() {
  const info = await algod.accountInformation(appAddr).do();
  return new Set((info.assets || []).map(a => a['asset-id']));
}

async function hasAcceptedBox(asaId) {
  try {
    await algod.getApplicationBoxByName(APP_ID, algosdk.encodeUint64(asaId)).do();
    return true;
  } catch (e) {
    const msg = e?.message || String(e);
    if (msg.includes('box not found') || msg.includes('404')) return false;
    return false;
  }
}

async function registerAsa(asaId, admin, lp, { accepted = false, opted = false } = {}) {
  if (accepted && opted) return 'already';

  const txns = [];
  if (!accepted) {
    const p = await algod.getTransactionParams().do();
    txns.push(algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      from: deployerAddr,
      to: appAddr,
      // Covers the ASA opt-in MBR plus the acceptance box MBR with a small cushion.
      amount: 120000,
      suggestedParams: p,
    }));
    txns.push(algosdk.makeApplicationCallTxnFromObject({
      from: deployerAddr,
      appIndex: APP_ID,
      appArgs: [
        new TextEncoder().encode('accept_asa'),
        algosdk.encodeUint64(asaId),
        algosdk.encodeUint64(admin),
        algosdk.encodeUint64(lp),
      ],
      boxes: [{ appIndex: APP_ID, name: algosdk.encodeUint64(asaId) }],
      suggestedParams: p,
    }));
  }

  if (!opted) {
    const p2 = await algod.getTransactionParams().do();
    p2.fee = 2000;
    p2.flatFee = true;
    txns.push(algosdk.makeApplicationCallTxnFromObject({
      from: deployerAddr,
      appIndex: APP_ID,
      appArgs: [new TextEncoder().encode('admin_optin'), algosdk.encodeUint64(asaId)],
      foreignAssets: [asaId],
      suggestedParams: p2,
    }));
  }

  algosdk.assignGroupID(txns);
  const signed = txns.map((txn) => txn.signTxn(deployer.sk));
  await algod.sendRawTransaction(signed).do();
  await algosdk.waitForConfirmation(algod, txns[txns.length - 1].txID(), 4);
  return !accepted && !opted ? 'accepted+opted' : !accepted ? 'accepted' : 'opted';
}

async function main() {
  console.log(`Mode: ${mode} | App: ${APP_ID} | Dry run: ${dryRun}`);

  const poolMap = await fetchLpPools();
  console.log(`LP pools loaded: ${Object.keys(poolMap).length}`);

  const registered = await getRegisteredAsas();
  console.log(`Already registered: ${registered.size} ASAs`);

  let targetAsas;
  let explicitTargets = null;
  if (mode === 'lofty-deals') {
    explicitTargets = await getLoftyDealsTargets();
    targetAsas = new Set(explicitTargets.keys());
  } else if (mode === 'single') {
    const asaId = Number(args[args.indexOf('--asa') + 1]);
    targetAsas = new Set([asaId]);
  } else if (mode === 'criteria') {
    targetAsas = await getCriteriaAsas(poolMap);
  } else {
    targetAsas = await getPortfolioAsas();
  }

  const toRegister = [];
  let assistLookup = null;
  async function getAssistMeta(asaId) {
    if (!assistLookup) {
      const assistItems = await fetch(LOFTYASSIST_API).then((r) => r.json());
      assistLookup = buildAssistLookup(assistItems || []);
    }
    const meta = assistLookup.byAssetId[Number(asaId)];
    const contracts = meta?.contracts || {};
    if (!meta || !contracts.admin || !contracts.lpInterface) return null;
    return {
      admin: contracts.admin,
      lp: contracts.lpInterface,
      name: meta.address || meta.slug || '?',
      price: meta.price || meta.tokenValue || null,
    };
  }

  for (const asaId of targetAsas) {
    const meta = explicitTargets?.get(asaId) || poolMap[asaId] || await getAssistMeta(asaId);
    if (!meta) continue;
    const accepted = await hasAcceptedBox(asaId);
    const opted = registered.has(asaId);
    if (accepted && opted) continue;
    toRegister.push({ asaId, ...meta, accepted, opted });
  }

  console.log(`\nTo register: ${toRegister.length} properties`);
  console.log(`Estimated cost: ~${(toRegister.length * 0.108).toFixed(2)} ALGO`);

  if (dryRun) {
    for (const r of toRegister) {
      console.log(`  ASA ${r.asaId} | ${r.name} | $${Number(r.price || 0).toFixed(2)} | accepted:${r.accepted} opted:${r.opted} | admin:${r.admin} lp:${r.lp}`);
    }
    return;
  }

  const info = await algod.accountInformation(deployerAddr).do();
  const spendable = (info.amount - (info['min-balance'] || 100000)) / 1e6;
  console.log(`GOV_ADMIN spendable: ${spendable.toFixed(3)} ALGO`);

  if (spendable < toRegister.length * 0.115) {
    console.log(`WARNING: May not have enough ALGO for all ${toRegister.length} registrations`);
  }

  let ok = 0, fail = 0;
  for (const r of toRegister) {
    try {
      const status = await registerAsa(r.asaId, r.admin, r.lp, { accepted: r.accepted, opted: r.opted });
      ok++;
      process.stdout.write(status === 'opted' ? 'o' : '.');
    } catch (e) {
      fail++;
      console.log(`\nFail ASA ${r.asaId} (${r.name}): ${e.message?.slice(0, 80)}`);
      if (e.message?.includes('below min')) {
        console.log('Out of ALGO. Stopping.');
        break;
      }
    }
  }

  console.log(`\nRegistered: ${ok} | Failed: ${fail}`);
  const finalInfo = await algod.accountInformation(deployerAddr).do();
  console.log(`GOV_ADMIN: ${(finalInfo.amount / 1e6).toFixed(3)} ALGO`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
