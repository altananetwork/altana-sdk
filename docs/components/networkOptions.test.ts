import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BNB, CELO, ETHEREUM } from '@altananetwork/sdk'
import {
  DEFAULT_NETWORK,
  NETWORK_OPTIONS,
  isNetworkId,
  networkFromSearch,
  networkOption,
  searchWithNetwork,
} from './networkOptions'

/**
 * The network choice on the getting-started pages. What a page shows for a
 * network (its name, the token to fund with, the explorer a transaction links
 * to, the config the live demo runs on) has to be that network's own.
 */

describe('the networks a reader can choose', () => {
  test('are BNB Smart Chain, Ethereum and Celo, in that order, BNB first as the default', () => {
    expect(NETWORK_OPTIONS.map((o) => o.id)).toEqual(['bnb', 'ethereum', 'celo'])
    expect(DEFAULT_NETWORK).toBe('bnb')
  })

  test('each one carries its own SDK config, export name, token and explorer', () => {
    const expected = { bnb: ['BNB', BNB], ethereum: ['ETHEREUM', ETHEREUM], celo: ['CELO', CELO] } as const
    for (const o of NETWORK_OPTIONS) {
      const [exportName, config] = expected[o.id]
      expect(o.exportName).toBe(exportName)
      expect(o.config).toBe(config)
      expect(o.label).toBe(config.chain.name)
      expect(o.symbol).toBe(config.chain.nativeCurrency.symbol)
      expect(o.explorerUrl).toBe(config.explorer)
    }
    expect(networkOption('celo').symbol).toBe('CELO')
    expect(networkOption('celo').explorerUrl).toBe('https://celoscan.io')
    expect(networkOption('celo').config.chainId).toBe(42220)
    expect(networkOption('ethereum').symbol).toBe('ETH')
    expect(networkOption('bnb').symbol).toBe('BNB')
  })
})

describe('the logo shown for each network', () => {
  test('is the file named after that network, and the file is in the site', () => {
    for (const o of NETWORK_OPTIONS) {
      expect(o.logo).toBe(`/chains/${o.id}.svg`)
      expect(existsSync(join(import.meta.dir, '..', 'public', o.logo))).toBe(true)
    }
  })

  test('only the one-color Ethereum logo is flipped to white on the dark theme', () => {
    expect(NETWORK_OPTIONS.filter((o) => o.logoIsOneColor).map((o) => o.id)).toEqual(['ethereum'])
  })
})

describe('the choice in the page address', () => {
  test('a page with no network in its address opens on the default', () => {
    expect(networkFromSearch('')).toBe('bnb')
    expect(networkFromSearch('?tab=private-key')).toBe('bnb')
  })

  test('a named network is used, whatever its letter case', () => {
    expect(networkFromSearch('?network=celo')).toBe('celo')
    expect(networkFromSearch('?network=Ethereum')).toBe('ethereum')
    expect(networkFromSearch('?a=1&network=celo')).toBe('celo')
  })

  test('an unknown network falls back to the default instead of breaking the page', () => {
    expect(networkFromSearch('?network=solana')).toBe('bnb')
    expect(networkFromSearch('?network=')).toBe('bnb')
    expect(isNetworkId('base')).toBe(false)
    expect(isNetworkId(undefined)).toBe(false)
  })

  test('choosing a network puts it in the address and keeps what else was there', () => {
    expect(searchWithNetwork('', 'celo')).toBe('?network=celo')
    expect(searchWithNetwork('?ref=x', 'ethereum')).toBe('?ref=x&network=ethereum')
    expect(searchWithNetwork('?network=celo', 'ethereum')).toBe('?network=ethereum')
  })

  test('the default network leaves the address clean', () => {
    expect(searchWithNetwork('?network=celo', 'bnb')).toBe('')
    expect(searchWithNetwork('?ref=x&network=celo', 'bnb')).toBe('?ref=x')
  })

  test('an address written by the picker is read back as the same network', () => {
    for (const o of NETWORK_OPTIONS) expect(networkFromSearch(searchWithNetwork('?ref=x', o.id))).toBe(o.id)
  })
})
