#!/usr/bin/env node
/**
 * Deploy EARLCoin KYC Registry.
 *
 * Usage:
 *   node contracts/deploy_kyc_registry.mjs [--testnet|--mainnet]
 *
 * Requires GOV_ADMIN_MNEMONIC.
 */
import algosdk from 'algosdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isTestnet = process.argv.includes('--testnet');
const algodUrl = isTestnet ? 'https://testnet-api.algonode.cloud' : (process.env.VITE_ALGOD_URL || process.env.ALGOD_URL || 'https://mainnet-api.4160.nodely.dev');
const algod = new algosdk.Algodv2('', algodUrl, '');
const mnemonic = (process.env.GOV_ADMIN_MNEMONIC || '').trim().replace(/\s+/g, ' ');
if (!mnemonic) { console.error('GOV_ADMIN_MNEMONIC required'); process.exit(1); }
const admin = algosdk.mnemonicToSecretKey(mnemonic);
const adminAddr = typeof admin.addr === 'string' ? admin.addr : algosdk.encodeAddress(admin.addr.publicKey);

const approvalTeal = fs.readFileSync(path.join(__dirname, 'build/kyc_registry_approval.teal'), 'utf8');
const clearTeal = fs.readFileSync(path.join(__dirname, 'build/kyc_registry_clear.teal'), 'utf8');

console.log('=== KYC Registry Deployment ===');
console.log(`Network: ${isTestnet ? 'testnet' : 'mainnet'}`);
console.log(`Admin:   ${adminAddr}`);

async function main() {
  const approvalCompiled = await algod.compile(Buffer.from(approvalTeal)).do();
  const clearCompiled = await algod.compile(Buffer.from(clearTeal)).do();
  const approvalProgram = new Uint8Array(Buffer.from(approvalCompiled.result, 'base64'));
  const clearProgram = new Uint8Array(Buffer.from(clearCompiled.result, 'base64'));
  console.log(`Approval: ${approvalProgram.length} bytes`);
  console.log(`Clear:    ${clearProgram.length} bytes`);

  const params = await algod.getTransactionParams().do();
  const txn = algosdk.makeApplicationCreateTxnFromObject({
    from: adminAddr,
    approvalProgram,
    clearProgram,
    numGlobalByteSlices: 1,
    numGlobalInts: 1,
    numLocalByteSlices: 0,
    numLocalInts: 4,
    suggestedParams: params,
    onComplete: algosdk.OnApplicationComplete.NoOpOC,
  });
  const signed = txn.signTxn(admin.sk);
  const { txId } = await algod.sendRawTransaction(signed).do();
  console.log(`Create tx: ${txId}`);
  const result = await algosdk.waitForConfirmation(algod, txId, 10);
  const appId = result['application-index'];
  console.log(`KYC_REGISTRY_APP_ID=${appId}`);
  console.log(`KYC_REGISTRY_ADDRESS=${algosdk.getApplicationAddress(appId)}`);
}

main().catch((err) => { console.error('Deploy failed:', err); process.exit(1); });
