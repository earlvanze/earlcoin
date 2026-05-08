#!/usr/bin/env node
/**
 * Admin helper for EARLCoin KYC registry.
 *
 * Commands:
 *   node scripts/kyc-registry-admin.mjs status <wallet>
 *   node scripts/kyc-registry-admin.mjs verify <wallet>
 *   node scripts/kyc-registry-admin.mjs block <wallet>
 *   node scripts/kyc-registry-admin.mjs revoke <wallet>
 *   node scripts/kyc-registry-admin.mjs recover <oldWallet> <newWallet>
 *
 * Wallets must opt into the registry before admin status writes can succeed.
 */
import algosdk from 'algosdk';
import fs from 'fs';

function loadDotEnv(path) {
  if (!fs.existsSync(path)) return;
  for (const raw of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}
loadDotEnv('.env.local');

const [cmd, wallet, newWallet] = process.argv.slice(2);
const APP_ID = Number(process.env.VITE_KYC_REGISTRY_APP_ID || process.env.KYC_REGISTRY_APP_ID || '0');
const ALGOD_URL = process.env.VITE_ALGOD_URL || process.env.ALGOD_URL || 'https://mainnet-api.4160.nodely.dev';
const mnemonic = (process.env.GOV_ADMIN_MNEMONIC || '').trim().replace(/\s+/g, ' ');
if (!APP_ID) { console.error('KYC_REGISTRY_APP_ID required'); process.exit(1); }
if (!cmd || !wallet) { console.error('Usage: status|verify|block|revoke|recover <wallet> [newWallet]'); process.exit(1); }

const algod = new algosdk.Algodv2('', ALGOD_URL, '');
const enc = new TextEncoder();

function localStateFor(account, appId) {
  const app = (account['apps-local-state'] || []).find((a) => a.id === appId);
  const out = { optedIn: !!app, verified: 0, blocked: 0, expires: 0, updated: 0 };
  for (const kv of app?.['key-value'] || []) {
    const key = Buffer.from(kv.key, 'base64').toString('utf8');
    out[key] = kv.value?.uint || 0;
  }
  return out;
}

async function printStatus(addr) {
  const account = await algod.accountInformation(addr).do();
  console.log(JSON.stringify({ wallet: addr, registryAppId: APP_ID, ...localStateFor(account, APP_ID) }, null, 2));
}

async function adminCall(method, target, args = []) {
  if (!mnemonic) throw new Error('GOV_ADMIN_MNEMONIC required for writes');
  const admin = algosdk.mnemonicToSecretKey(mnemonic);
  const adminAddr = typeof admin.addr === 'string' ? admin.addr : algosdk.encodeAddress(admin.addr.publicKey);
  const params = await algod.getTransactionParams().do();
  const txn = algosdk.makeApplicationCallTxnFromObject({
    from: adminAddr,
    appIndex: APP_ID,
    appArgs: [enc.encode(method), ...args.map((n) => algosdk.encodeUint64(Number(n)))],
    accounts: [target],
    suggestedParams: params,
  });
  const signed = txn.signTxn(admin.sk);
  const { txId } = await algod.sendRawTransaction(signed).do();
  await algosdk.waitForConfirmation(algod, txId, 6);
  console.log(`${method} ${target}: ${txId}`);
}

async function main() {
  if (cmd === 'status') return printStatus(wallet);
  if (cmd === 'verify') return adminCall('verify', wallet);
  if (cmd === 'block') return adminCall('block', wallet);
  if (cmd === 'revoke') return adminCall('revoke', wallet);
  if (cmd === 'recover') {
    if (!newWallet) throw new Error('recover requires <oldWallet> <newWallet>');
    await adminCall('block', wallet);
    await adminCall('verify', newWallet);
    return;
  }
  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
