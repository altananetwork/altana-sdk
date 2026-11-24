// The built packages load with require() from CommonJS: a tsx script that
// resolves as CJS, a Jest config without ESM, any tool still on require().
// The packages are ES modules; Node loads them through require() from 20.19
// and 22.12 on. Each package's `default` export condition is what lets
// require() find the entry point at all; without it Node throws
// ERR_PACKAGE_PATH_NOT_EXPORTED before reading a line of the code.
if (!process.features.require_module) {
  console.log(`require() check skipped: Node ${process.version} cannot require() an ES module`);
  process.exit(0);
}

const sdk = require("@altananetwork/sdk");
const x402 = require("@altananetwork/x402-server");

const need = (mod, name, names) => {
  for (const n of names) {
    if (!(n in mod)) throw new Error(`${name} does not export ${n} through require()`);
  }
};
need(sdk, "@altananetwork/sdk", ["createClient", "BNB", "signerFromPrivateKey", "serializeSession"]);
need(x402, "@altananetwork/x402-server", ["settlePayment"]);

const client = sdk.createClient({ chains: [sdk.BNB] });
if (typeof client.execute !== "function") throw new Error("client.execute is missing through require()");
console.log(`required ${Object.keys(sdk).length} sdk exports and ${Object.keys(x402).length} x402-server exports`);
