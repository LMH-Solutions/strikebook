const test = require("node:test");
const assert = require("node:assert");
const { digitalAboveProb, realizedVol, strikeForProb } = require("../src/lib/pricing.cjs");
const { parseStrikeName } = require("../src/lib/resolver.cjs");
const { decodePriceUpdateV2 } = require("../src/lib/feeds.cjs");

test("ATM digital is just under 50% (lognormal drift term)", () => {
  const p = digitalAboveProb({ spot: 100, strike: 100, sigmaAnnual: 0.6, secsToExpiry: 86400 });
  assert.ok(p < 0.5 && p > 0.49, String(p));
});
test("deep ITM/OTM and expiry", () => {
  assert.ok(digitalAboveProb({ spot: 200, strike: 100, sigmaAnnual: 0.6, secsToExpiry: 86400 }) > 0.999);
  assert.ok(digitalAboveProb({ spot: 50, strike: 100, sigmaAnnual: 0.6, secsToExpiry: 86400 }) < 0.001);
  assert.strictEqual(digitalAboveProb({ spot: 101, strike: 100, sigmaAnnual: 0.6, secsToExpiry: 0 }), 1);
});
test("strikeForProb inverts digitalAboveProb", () => {
  for (const prob of [0.1, 0.5, 0.9]) {
    const k = strikeForProb({ spot: 100, sigmaAnnual: 0.5, secsToExpiry: 3 * 86400, prob });
    const back = digitalAboveProb({ spot: 100, strike: k, sigmaAnnual: 0.5, secsToExpiry: 3 * 86400 });
    assert.ok(Math.abs(back - prob) < 1e-6, `${prob} -> ${back}`);
  }
});
test("realizedVol of constant series is 0", () => assert.strictEqual(realizedVol([1, 1, 1, 1], 3600), 0));
test("parseStrikeName", () => {
  assert.deepStrictEqual(parseStrikeName("SOL>150@1764950400"), { asset: "SOL", strike: 150, endTs: 1764950400 });
  assert.strictEqual(parseStrikeName("Will BTC top 200k?"), null);
});
test("decodePriceUpdateV2 (real SOL account sample)", () => {
  const b = Buffer.from("IvEjY51+9M1gMUcENA3t3zcf1CRyFI8kjp0abRpesqw6zYt/1dayQwHvDYtv2izrpB2hXUCV0do5Kg0vjtDGx7wPTPrIwoC1bcDHBlcCAAAAnTZGAAAAAAD4////YUPjagAAAABgQ+NqAAAAAE7E/lUCAAAAGQBFAAAAAAAGJJcbAAAAAAA=", "base64");
  const d = decodePriceUpdateV2(b);
  assert.strictEqual(d.feedId, "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d");
  assert.strictEqual(d.expo, -8);
  assert.ok(d.price > 1 && d.price < 10000);
});
