/**
 * The network choice on the getting-started pages: one picker, and the pieces
 * of a page that follow it (a code sample per network, the token to fund with,
 * the live demo).
 *
 * The choice lives outside React so that the picker, the demo and the samples,
 * which sit in different parts of an MDX page, all read the same value.
 */
import { useSyncExternalStore, type ReactNode } from 'react'
import {
  DEFAULT_NETWORK,
  NETWORK_OPTIONS,
  networkFromSearch,
  networkOption,
  searchWithNetwork,
  type NetworkId,
  type NetworkOption,
} from './networkOptions'

let current: NetworkId = DEFAULT_NETWORK
let readFromAddress = false
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function snapshot(): NetworkId {
  // The page address is read once, on the first render in the browser.
  if (!readFromAddress && typeof window !== 'undefined') {
    readFromAddress = true
    current = networkFromSearch(window.location.search)
  }
  return current
}

export function setNetwork(id: NetworkId) {
  readFromAddress = true
  current = id
  try {
    const { pathname, search, hash } = window.location
    history.replaceState(null, '', `${pathname}${searchWithNetwork(search, id)}${hash}`)
  } catch {
    // The address is a convenience; the choice still applies without it.
  }
  for (const listener of listeners) listener()
}

/** The network the reader chose. Pages are prerendered with the default one. */
export function useNetwork(): NetworkOption {
  return networkOption(useSyncExternalStore(subscribe, snapshot, () => DEFAULT_NETWORK))
}

/** A network's logo. The name is always written next to it, so it carries no text of its own. */
export function NetworkLogo({ network }: { network: NetworkOption }) {
  return (
    <img
      src={network.logo}
      alt=""
      className={network.logoIsOneColor ? 'network-logo network-logo-one-color' : 'network-logo'}
    />
  )
}

/** The row of network buttons, each with its logo. */
export function NetworkPicker() {
  const network = useNetwork()
  return (
    <div className="network-picker" role="group" aria-label="Network">
      {NETWORK_OPTIONS.map((o) => (
        <button
          key={o.id}
          type="button"
          className="network-option"
          aria-pressed={o.id === network.id}
          onClick={() => setNetwork(o.id)}
        >
          <NetworkLogo network={o} />
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** A network's logo and name, inline in a sentence or a title. The chosen network unless one is given. */
export function NetworkBadge({ network }: { network?: NetworkOption }) {
  const chosen = useNetwork()
  const shown = network ?? chosen
  return (
    <span className="network-badge">
      <NetworkLogo network={shown} />
      {shown.label}
    </span>
  )
}

/** Shows its content only while `id` is the chosen network. */
export function OnNetwork({ id, children }: { id: NetworkId; children: ReactNode }) {
  return useNetwork().id === id ? <>{children}</> : null
}

/** The chosen network's name, inline. */
export function NetworkName() {
  return <>{useNetwork().label}</>
}

/** The chosen network's native token, inline. */
export function NetworkSymbol() {
  return <>{useNetwork().symbol}</>
}
