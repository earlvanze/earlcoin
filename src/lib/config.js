
const firstNonEmpty = (...values) => values.find((value) => typeof value === 'string' && value.trim().length > 0) || '';

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
export const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';

export const ALGOD_URL = firstNonEmpty(
  import.meta.env.VITE_ALGOD_URL,
  import.meta.env.VITE_ALGONODE_URL,
) || 'https://mainnet-api.4160.nodely.dev';
export const INDEXER_URL = firstNonEmpty(
  import.meta.env.VITE_INDEXER_URL,
  import.meta.env.VITE_ALGONODE_IDX,
) || 'https://mainnet-idx.4160.nodely.dev';
export const NETWORK = firstNonEmpty(import.meta.env.VITE_NETWORK) || 'mainnet';

export const EARL_ASA_ID = Number(firstNonEmpty(import.meta.env.VITE_EARL_ASA_ID) || '3497993904');
export const VNFT_ADMIN_ADDRESS = import.meta.env.VITE_VNFT_ADMIN_ADDRESS || 'DTXJYIPBBFDMREX27RS4ZY6YN7E455ASXKCYAENM77SJIEVPWB2UZZAPMA';
export const VNFT_ASA_ID = Number(firstNonEmpty(import.meta.env.VITE_VNFT_ASA_ID) || '752159356');
export const KYC_REGISTRY_APP_ID = Number(firstNonEmpty(import.meta.env.VITE_KYC_REGISTRY_APP_ID) || '0');
export const USDC_ASA_ID = Number(firstNonEmpty(import.meta.env.VITE_USDC_ASA_ID) || '31566704');
export const GOBTC_ASA_ID = Number(firstNonEmpty(import.meta.env.VITE_GOBTC_ASA_ID) || '386192725');
export const GOBTC_DECIMALS = 8;
export const GOV_APP_ID = Number(import.meta.env.VITE_GOV_APP_ID || '0');
export const TREASURY_ESCROW_APP_ID = Number(import.meta.env.VITE_TREASURY_ESCROW_APP_ID || '3516307746');
export const VOTE_DELEGATION_APP_ID = Number(import.meta.env.VITE_VOTE_DELEGATION_APP_ID || '3516309799');
// Mainnet in-kind exchange app deployed by GOV_ADMIN. Can be overridden per environment.
const configuredInkindExchangeAppId = Number(import.meta.env.VITE_INKIND_EXCHANGE_APP_ID || 0);
export const INKIND_EXCHANGE_APP_ID = configuredInkindExchangeAppId > 0 ? configuredInkindExchangeAppId : 3547976062;


export const STRIPE_PUBLISHABLE_KEY = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || '';
export const EARL_STRIPE_PRICE_ID = import.meta.env.VITE_EARL_STRIPE_PRICE_ID || '';
export const MEMBERSHIP_STRIPE_PRICE_ID = import.meta.env.VITE_MEMBERSHIP_STRIPE_PRICE_ID || '';
export const SITE_URL = import.meta.env.VITE_SITE_URL || (typeof window !== 'undefined' ? window.location.origin : '');


