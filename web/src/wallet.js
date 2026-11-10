// In-page DEVNET burner wallet storage (pure: the Keypair class and the storage are injected, so this is unit-testable
// without a browser). The secret key lives only in this browser's localStorage under KEY. It never leaves the page,
// is never sent anywhere, and is only ever used against Solana devnet.
export const KEY = "strikebook.devnet-burner.v1";

export function encodeSecret(secretKey) { return JSON.stringify(Array.from(secretKey)); }
export function decodeSecret(text) {
  const arr = JSON.parse(text);
  if (!Array.isArray(arr) || arr.length !== 64 || !arr.every((n) => Number.isInteger(n) && n >= 0 && n < 256)) throw new Error("not a 64-byte secret key");
  return Uint8Array.from(arr);
}

// Returns the stored burner, or null. A corrupt entry is treated as absent (and left for the user to reset).
export function loadBurner(storage, Keypair) {
  const raw = storage?.getItem(KEY);
  if (!raw) return null;
  try { return Keypair.fromSecretKey(decodeSecret(raw)); } catch { return null; }
}
export function createBurner(storage, Keypair) {
  const kp = Keypair.generate();
  storage.setItem(KEY, encodeSecret(kp.secretKey));
  return kp;
}
export const loadOrCreateBurner = (storage, Keypair) => loadBurner(storage, Keypair) || createBurner(storage, Keypair);
export function resetBurner(storage) { storage.removeItem(KEY); }
// Export format = the Solana CLI keypair file format (JSON byte array), so `solana-keygen`/Phantom import both work.
export const exportBurner = (kp) => encodeSecret(kp.secretKey);

// Refuse any non-devnet RPC: the pm-AMM program id is the same on mainnet with real USDC.
export function assertDevnetRpc(url) {
  if (!/devnet/i.test(String(url)) || /mainnet/i.test(String(url))) throw new Error(`refusing to sign against ${url}: devnet only`);
  return url;
}
export const shortAddr = (a) => (a ? `${String(a).slice(0, 4)}…${String(a).slice(-4)}` : "–");
