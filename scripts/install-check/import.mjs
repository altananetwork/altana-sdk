// The built packages load under plain Node and export what a consumer reaches for.
import * as sdk from "@altananetwork/sdk";
import * as x402 from "@altananetwork/x402-server";

const need = (mod, name, names) => {
  for (const n of names) {
    if (!(n in mod)) throw new Error(`${name} does not export ${n}`);
  }
};
need(sdk, "@altananetwork/sdk", [
  "createClient",
  "BNB",
  "ETHEREUM",
  "CELO",
  "BNB_TESTNET",
  "NETWORKS",
  "signerFromPrivateKey",
  "signerFromPasskey",
  "serializeSession",
  "deserializeSession",
]);
need(x402, "@altananetwork/x402-server", ["settlePayment"]);

const client = sdk.createClient({ chains: [sdk.BNB, sdk.ETHEREUM] });
for (const method of ["createWallet", "grantSession", "revokeSession", "execute"]) {
  if (typeof client[method] !== "function") throw new Error(`client.${method} is missing`);
}
console.log(`imported ${Object.keys(sdk).length} sdk exports and ${Object.keys(x402).length} x402-server exports`);
