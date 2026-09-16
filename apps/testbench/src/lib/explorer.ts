import { networkByChainId } from "@altananetwork/sdk";

function base(chainId: number): string | undefined {
  return networkByChainId(chainId)?.explorer?.replace(/\/$/, "");
}

export function txUrl(chainId: number, hash: string): string | undefined {
  const b = base(chainId);
  return b ? `${b}/tx/${hash}` : undefined;
}

export function addressUrl(chainId: number, address: string): string | undefined {
  const b = base(chainId);
  return b ? `${b}/address/${address}` : undefined;
}

export function tokenUrl(chainId: number, address: string): string | undefined {
  const b = base(chainId);
  return b ? `${b}/token/${address}` : undefined;
}
