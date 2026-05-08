/**
 * Deploy In-Kind Exchange Contract to Algorand
 *
 * Deploys the DODO PMM in-kind exchange contract that atomically
 * swaps Lofty property tokens for EARL at on-chain PMM prices.
 *
 * Usage:
 *   node contracts/deploy_inkind.mjs [--testnet|--mainnet]
 *
 * Env vars required:
 *   GOV_ADMIN_MNEMONIC — deployer/admin account
 *   EARL_ASA_ID (or VITE_EARL_ASA_ID)
 *   KYC_REGISTRY_APP_ID (or VITE_KYC_REGISTRY_APP_ID)
 *   INKIND_EARL_PRICE — EARL price in dollars (e.g., 100 = $100/EARL)
 */

import algosdk from 'algosdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const raw of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim().replace(/^[\"']|[\"']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

loadDotEnv('.env.local');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isTestnet = process.argv.includes('--testnet');
const algodUrl = isTestnet
  ? 'https://testnet-api.algonode.cloud'
  : (process.env.VITE_ALGOD_URL || process.env.ALGOD_URL || 'https://mainnet-api.4160.nodely.dev');

const algod = new algosdk.Algodv2('', algodUrl, '');
const mnemonic = (process.env.GOV_ADMIN_MNEMONIC || '').trim().replace(/\s+/g, ' ');
if (!mnemonic) { console.error('GOV_ADMIN_MNEMONIC required'); process.exit(1); }
const deployer = algosdk.mnemonicToSecretKey(mnemonic);
const deployerAddr = typeof deployer.addr === 'string'
  ? deployer.addr
  : algosdk.encodeAddress(deployer.addr.publicKey);

const earlAsaId = Number(process.env.VITE_EARL_ASA_ID || process.env.EARL_ASA_ID || '0');
const kycRegistryAppId = Number(process.env.VITE_KYC_REGISTRY_APP_ID || process.env.KYC_REGISTRY_APP_ID || '0');
const earlPrice = Number(process.env.INKIND_EARL_PRICE || '100');
if (!earlAsaId) { console.error('EARL_ASA_ID required'); process.exit(1); }
if (!kycRegistryAppId) { console.error('KYC_REGISTRY_APP_ID required'); process.exit(1); }

// Price in "micro-units" matching EARL ASA decimals (6)
// $100 EARL → 100 * 10^6 = 100_000_000 micro-EARL per whole unit
const earlPriceMicro = earlPrice * 1_000_000;

console.log('=== In-Kind Exchange Deployment ===');
console.log(`Network:     ${isTestnet ? 'testnet' : 'mainnet'}`);
console.log(`Deployer:     ${deployerAddr}`);
console.log(`EARL ASA:     ${earlAsaId}`);
console.log(`KYC Registry: ${kycRegistryAppId}`);
console.log(`EARL Price:   $${earlPrice} (${earlPriceMicro} micro-units)`);
console.log('');

const approvalTeal = fs.readFileSync(path.join(__dirname, 'build/inkind_exchange_approval.teal'), 'utf8');
const clearTeal = fs.readFileSync(path.join(__dirname, 'build/inkind_exchange_clear.teal'), 'utf8');

async function main() {
  // Step 0: Delete previous failed app if it exists
  const PREV_APP_ID = 3518919406;
  try {
    const prevInfo = await algod.getApplicationByID(PREV_APP_ID).do();
    if (prevInfo.params.creator === deployerAddr) {
      console.log(`Deleting previous failed app ${PREV_APP_ID}...`);
      const delParams = await algod.getTransactionParams().do();
      const delTxn = algosdk.makeApplicationDeleteTxnFromObject({
        from: deployerAddr,
        appIndex: PREV_APP_ID,
        suggestedParams: delParams,
      });
      const signedDel = delTxn.signTxn(deployer.sk);
      await algod.sendRawTransaction(signedDel).do();
      await algosdk.waitForConfirmation(algod, delTxn.txID(), 10);
      console.log('  Previous app deleted');
    }
  } catch (e) {
    console.log('  No previous app to delete');
  }

  // Step 1: Compile TEAL
  console.log('\nCompiling TEAL programs...');
  const approvalCompiled = await algod.compile(Buffer.from(approvalTeal)).do();
  const clearCompiled = await algod.compile(Buffer.from(clearTeal)).do();

  const approvalProgram = new Uint8Array(Buffer.from(approvalCompiled.result, 'base64'));
  const clearProgram = new Uint8Array(Buffer.from(clearCompiled.result, 'base64'));
  console.log(`  Approval: ${approvalProgram.length} bytes`);
  console.log(`  Clear:    ${clearProgram.length} bytes`);

  // Step 2: Create application
  console.log('\nCreating application...');
  const params = await algod.getTransactionParams().do();
  const txn = algosdk.makeApplicationCreateTxnFromObject({
    from: deployerAddr,
    approvalProgram,
    clearProgram,
    numGlobalByteSlices: 1,   // admin address
    numGlobalInts: 5,          // earl_asa, kyc_registry_app, earl_price, paused, num_accepted
    numLocalByteSlices: 0,
    numLocalInts: 0,
    suggestedParams: params,
    onComplete: algosdk.OnApplicationComplete.NoOpOC,
    extraPages: 1,             // boxes need extra page (1 is enough for ~8 ASAs)
  });

  const signed = txn.signTxn(deployer.sk);
  const { txId: createTxId } = await algod.sendRawTransaction(signed).do();
  console.log(`  Create tx: ${createTxId}`);

  const result = await algosdk.waitForConfirmation(algod, createTxId, 10);
  const appId = result['application-index'];
  const appAddr = algosdk.getApplicationAddress(appId);
  console.log(`  App ID:    ${appId}`);
  console.log(`  App Addr:  ${appAddr}`);

  // Step 3: Fund app with min balance (boxes need extra)
  console.log('\nFunding app address...');
  const fundParams = await algod.getTransactionParams().do();
  const fundTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    from: deployerAddr,
    to: appAddr,
    amount: 200_000, // 0.2 ALGO minimum for app MBR
    suggestedParams: fundParams,
  });
  const signedFund = fundTxn.signTxn(deployer.sk);
  await algod.sendRawTransaction(signedFund).do();
  await algosdk.waitForConfirmation(algod, fundTxn.txID(), 4);
  console.log('  Funded with 0.2 ALGO');

  // Step 4: Setup — initialize global state
  console.log('\nCalling setup()...');
  const setupParams = await algod.getTransactionParams().do();
  const setupTxn = algosdk.makeApplicationCallTxnFromObject({
    from: deployerAddr,
    appIndex: appId,
    appArgs: [
      new TextEncoder().encode('setup'),
      algosdk.encodeUint64(earlAsaId),
      algosdk.encodeUint64(kycRegistryAppId),
      algosdk.encodeUint64(earlPriceMicro),
    ],
    suggestedParams: setupParams,
  });
  const signedSetup = setupTxn.signTxn(deployer.sk);
  await algod.sendRawTransaction(signedSetup).do();
  await algosdk.waitForConfirmation(algod, setupTxn.txID(), 4);
  console.log('  Setup complete');

  // Step 5: Opt app into EARL ASA (so it can send EARL)
  console.log('\nOpting app into EARL ASA...');
  const earlOptinParams = await algod.getTransactionParams().do();
  earlOptinParams.fee = 2000;
  earlOptinParams.flatFee = true;
  const earlOptin = algosdk.makeApplicationCallTxnFromObject({
    from: deployerAddr,
    appIndex: appId,
    appArgs: [
      new TextEncoder().encode('admin_optin'),
      algosdk.encodeUint64(earlAsaId),
    ],
    foreignAssets: [earlAsaId],
    suggestedParams: earlOptinParams,
  });
  const signedEarlOptin = earlOptin.signTxn(deployer.sk);
  await algod.sendRawTransaction(signedEarlOptin).do();
  await algosdk.waitForConfirmation(algod, earlOptin.txID(), 4);
  console.log(`  Opted into EARL (${earlAsaId})`);

  console.log('\n=== Deployment Complete ===');
  console.log(`INKIND_EXCHANGE_APP_ID=${appId}`);
  console.log(`INKIND_EXCHANGE_ADDRESS=${appAddr}`);
  console.log('\nNext steps:');
  console.log('1. Transfer EARL tokens to the app address to fund swaps');
  console.log('2. Call accept_asa() for each Lofty property ASA');
  console.log('3. Call admin_optin() for each Lofty property ASA (so app can receive them)');
  console.log('4. Set VITE_INKIND_EXCHANGE_APP_ID in .env.local');
  console.log('5. Set VITE_KYC_REGISTRY_APP_ID in .env.local');
}

main().catch(err => { console.error('Deploy failed:', err); process.exit(1); });