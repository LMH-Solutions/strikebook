import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { KEY, loadBurner, createBurner, loadOrCreateBurner, resetBurner, exportBurner, decodeSecret, assertDevnetRpc, shortAddr } from "./wallet.js";

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };

describe("devnet burner wallet", () => {
  it("creates once, then reloads the same keypair from storage", () => {
    const st = mem();
    expect(loadBurner(st, Keypair)).toBeNull();
    const a = loadOrCreateBurner(st, Keypair);
    const b = loadOrCreateBurner(st, Keypair);
    expect(b.publicKey.toBase58()).toBe(a.publicKey.toBase58());
    expect(JSON.parse(st.getItem(KEY))).toHaveLength(64);
  });
  it("export round-trips (Solana CLI JSON) and reset forgets it", () => {
    const st = mem();
    const a = createBurner(st, Keypair);
    expect(Keypair.fromSecretKey(decodeSecret(exportBurner(a))).publicKey.equals(a.publicKey)).toBe(true);
    resetBurner(st);
    expect(loadBurner(st, Keypair)).toBeNull();
    expect(loadOrCreateBurner(st, Keypair).publicKey.equals(a.publicKey)).toBe(false);
  });
  it("corrupt storage is treated as no wallet; decodeSecret validates", () => {
    const st = mem(); st.setItem(KEY, "[1,2,3]");
    expect(loadBurner(st, Keypair)).toBeNull();
    expect(() => decodeSecret("[300" + ",0".repeat(63) + "]")).toThrow();
    expect(() => decodeSecret('"x"')).toThrow();
  });
  it("refuses non-devnet RPCs", () => {
    expect(assertDevnetRpc("https://api.devnet.solana.com")).toBe("https://api.devnet.solana.com");
    expect(() => assertDevnetRpc("https://api.mainnet-beta.solana.com")).toThrow(/devnet only/);
    expect(() => assertDevnetRpc("https://my-rpc.example.com")).toThrow(/devnet only/);
    expect(shortAddr("GDwVtusABCDEFG")).toBe("GDwV…DEFG");
  });
});
