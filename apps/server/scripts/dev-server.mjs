// Explicit dev launcher for the artoo server (#28 3a review).
//
// The dev-only device-auth env (pairing pepper + dev node-token escape) is set
// HERE, by an explicit dev entrypoint — never silently inside main.ts. Production
// runs `node dist/main.js` directly with real env and fails closed without a
// pairing pepper. `??=` means a real env value (if the operator sets one) wins.
process.env.ARTOO_PAIRING_PEPPER ??= "dev-pairing-pepper";
process.env.ARTOO_ALLOW_DEV_NODE_TOKEN ??= "1";

await import("../dist/main.js");
