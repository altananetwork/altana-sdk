/**
 * The networks a reader can choose on the getting-started pages, and how the
 * choice is kept in the page address (`?network=celo`), so a link opens on the
 * same network it was copied from.
 *
 * No React here, so it is unit tested on its own (networkOptions.test.ts).
 * Every value a page shows comes from the SDK's own config for that network.
 */
import { BNB, CELO, ETHEREUM, type NetworkConfig } from '@altananetwork/sdk'

export type NetworkId = 'bnb' | 'ethereum' | 'celo'

export type NetworkOption = {
  id: NetworkId
  /** The network's name as the pages write it. */
  label: string
  /** The config's export name in `@altananetwork/sdk`, as code samples import it. */
  exportName: 'BNB' | 'ETHEREUM' | 'CELO'
  /** The native token a new wallet is funded with. */
  symbol: string
  /** Block explorer base URL. */
  explorerUrl: string
  /** The network's logo, a file under `public/`. */
  logo: string
  /** A one-color logo drawn in black, shown in white on the dark theme. */
  logoIsOneColor: boolean
  config: NetworkConfig
}

function option(
  id: NetworkId,
  exportName: NetworkOption['exportName'],
  config: NetworkConfig,
  logoIsOneColor = false,
): NetworkOption {
  return {
    id,
    label: config.chain.name,
    exportName,
    symbol: config.chain.nativeCurrency.symbol,
    explorerUrl: config.explorer,
    logo: `/chains/${id}.svg`,
    logoIsOneColor,
    config,
  }
}

/** In the order the pages list them. BNB Smart Chain is the SDK default. */
export const NETWORK_OPTIONS: readonly NetworkOption[] = [
  option('bnb', 'BNB', BNB),
  option('ethereum', 'ETHEREUM', ETHEREUM, true),
  option('celo', 'CELO', CELO),
]

export const DEFAULT_NETWORK: NetworkId = 'bnb'

export function isNetworkId(value: unknown): value is NetworkId {
  return NETWORK_OPTIONS.some((o) => o.id === value)
}

export function networkOption(id: NetworkId): NetworkOption {
  return NETWORK_OPTIONS.find((o) => o.id === id) ?? NETWORK_OPTIONS[0]!
}

/** The network a page address asks for; the default when it names none or an unknown one. */
export function networkFromSearch(search: string): NetworkId {
  const value = new URLSearchParams(search).get('network')?.toLowerCase()
  return isNetworkId(value) ? value : DEFAULT_NETWORK
}

/** The same query string with the network set. The default network is left out of the address. */
export function searchWithNetwork(search: string, id: NetworkId): string {
  const params = new URLSearchParams(search)
  if (id === DEFAULT_NETWORK) params.delete('network')
  else params.set('network', id)
  const out = params.toString()
  return out ? `?${out}` : ''
}
