import algosdk from 'algosdk';
import { ALGOD_URL, INDEXER_URL, VNFT_ADMIN_ADDRESS, KYC_REGISTRY_APP_ID } from './config';

export const algodClient = new algosdk.Algodv2('', ALGOD_URL, '');
export const indexerClient = new algosdk.Indexer('', INDEXER_URL, '');

export async function hasAsset(accountAddress, assetId) {
  if (!accountAddress || !assetId) return false;
  try {
    const res = await indexerClient.lookupAccountAssets(accountAddress).assetId(assetId).do();
    const assets = res?.assets || [];
    return assets.some((a) => a['asset-id'] === assetId && (a.amount ?? 0) > 0);
  } catch (err) {
    // Fallback: full account lookup
    try {
      const acct = await indexerClient.lookupAccountByID(accountAddress).do();
      const assets = acct?.account?.assets || [];
      return assets.some((a) => a['asset-id'] === assetId && (a.amount ?? 0) > 0);
    } catch {
      return false;
    }
  }
}

export async function getVnftAssetId(accountAddress) {
  if (!accountAddress || !VNFT_ADMIN_ADDRESS) return null;

  const matchesVnft = (params) => (
    params &&
    params['unit-name'] === 'VNFT' &&
    (params.manager === VNFT_ADMIN_ADDRESS || params.creator === VNFT_ADMIN_ADDRESS)
  );

  try {
    const acct = await indexerClient.lookupAccountByID(accountAddress).do();
    const assets = acct?.account?.assets || [];
    for (const a of assets) {
      if (!a['asset-id'] || (a.amount ?? 0) === 0) continue;
      const asset = await indexerClient.lookupAssetByID(a['asset-id']).do();
      const params = asset?.asset?.params || {};
      if (matchesVnft(params)) {
        return a['asset-id'];
      }
    }
  } catch {
    // fallback to algod
  }

  try {
    const acct = await algodClient.accountInformation(accountAddress).do();
    const assets = acct?.assets || [];
    for (const a of assets) {
      if (!a['asset-id'] || (a.amount ?? 0) === 0) continue;
      const asset = await algodClient.getAssetByID(a['asset-id']).do();
      const params = asset?.params || {};
      if (matchesVnft(params)) {
        return a['asset-id'];
      }
    }
  } catch {
    return null;
  }

  return null;
}

export async function hasVnft(accountAddress) {
  const assetId = await getVnftAssetId(accountAddress);
  return !!assetId;
}

function decodeLocalState(localState = []) {
  const out = {};
  for (const kv of localState) {
    const key = atob(kv.key);
    out[key] = kv.value?.uint ?? kv.value?.bytes ?? null;
  }
  return out;
}

export async function getKycRegistryStatus(accountAddress, appId = KYC_REGISTRY_APP_ID) {
  if (!accountAddress || !appId) {
    return { enabled: false, optedIn: false, verified: false, blocked: false, expires: 0, active: false };
  }

  try {
    const acct = await indexerClient.lookupAccountByID(accountAddress).do();
    const appLocal = (acct?.account?.['apps-local-state'] || []).find((app) => app.id === appId);
    if (!appLocal) {
      return { enabled: true, optedIn: false, verified: false, blocked: false, expires: 0, active: false };
    }
    const state = decodeLocalState(appLocal['key-value'] || []);
    const expires = Number(state.expires || 0);
    const now = Math.floor(Date.now() / 1000);
    const verified = Number(state.verified || 0) === 1;
    const blocked = Number(state.blocked || 0) === 1;
    return {
      enabled: true,
      optedIn: true,
      verified,
      blocked,
      expires,
      updated: Number(state.updated || 0),
      active: verified && !blocked && (expires === 0 || expires > now),
    };
  } catch {
    return { enabled: true, optedIn: false, verified: false, blocked: false, expires: 0, active: false, error: true };
  }
}
