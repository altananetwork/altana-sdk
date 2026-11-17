import { useState, useCallback, useEffect } from 'react'
import { createClient } from '@altananetwork/sdk'
import type { Wallet, Signer } from '@altananetwork/sdk'
import { getAddress } from 'viem'
import { AltanaButton, CopyButton, StatusBox, StepCard, TxConfirmed } from './demo/primitives'
import type { StepStatus } from './demo/primitives'
import { formatAmount } from './demo/amounts'
import { NetworkBadge, useNetwork } from './Network'
import { networkOption } from './networkOptions'
import type { NetworkId, NetworkOption } from './networkOptions'

// One client per network, made the first time that network is chosen.
const clients = new Map<string, ReturnType<typeof createClient>>()
function clientFor(network: NetworkOption) {
  let client = clients.get(network.id)
  if (!client) {
    client = createClient({ chains: [network.config] })
    clients.set(network.id, client)
  }
  return client
}

type WalletState = {
  wallet: Wallet & { signer: Signer }
  address: string
} | null

/** The session key the demo creates: what it may do, and for how long. */
const SESSION_SPEND_LIMIT = 1_000_000_000_000_000n // 0.001 of the native token a day
const SESSION_LIFETIME_SECS = 60 * 60

const KEYSTORE_EXPLORER = 'https://explorer.altana.network'

const successBox = {
  marginTop: '0.75rem', padding: '0.75rem 1rem', background: '#d1fae5',
  borderRadius: '6px', fontSize: '0.875rem', color: '#065f46',
  fontFamily: 'var(--vocs-fontFamily_mono)', display: 'flex', alignItems: 'center', gap: '0.25rem',
} as const

const note = { margin: '0.75rem 0 0', fontSize: '0.85rem', color: 'var(--vocs-color_text2)' } as const

// ── main demo ────────────────────────────────────────────────────────────────

/**
 * The live demo on the chosen network. Each network keeps its own demo while
 * the page is open, so a wallet created on one network is still there after
 * looking at another.
 */
export function PasskeyDemo() {
  const network = useNetwork()
  const [opened, setOpened] = useState<NetworkId[]>([network.id])
  useEffect(() => {
    setOpened((ids) => (ids.includes(network.id) ? ids : [...ids, network.id]))
  }, [network.id])
  const shown = opened.includes(network.id) ? opened : [...opened, network.id]

  return (
    <>
      {shown.map((id) => (
        <div key={id} hidden={id !== network.id}>
          <PasskeyDemoOn network={networkOption(id)} />
        </div>
      ))}
    </>
  )
}

function PasskeyDemoOn({ network }: { network: NetworkOption }) {
  const client = clientFor(network)

  const [createStatus, setCreateStatus] = useState<StepStatus>('idle')
  const [walletState, setWalletState] = useState<WalletState>(null)
  const [createError, setCreateError] = useState('')

  const [balance, setBalance] = useState<bigint | null>(null)

  const [txStatus, setTxStatus] = useState<StepStatus>('idle')
  const [txHash, setTxHash] = useState('')
  const [txError, setTxError] = useState('')
  // True once the wallet's passkey is in the Keystore: after activating here, or for a recovered wallet.
  const [activated, setActivated] = useState(false)

  const [sessionStatus, setSessionStatus] = useState<StepStatus>('idle')
  const [sessionHash, setSessionHash] = useState('')
  const [sessionError, setSessionError] = useState('')

  const [recoverStatus, setRecoverStatus] = useState<StepStatus>('idle')
  const [recoveredAddress, setRecoveredAddress] = useState('')
  const [recoverError, setRecoverError] = useState('')

  const funded = balance !== null && balance > 0n

  // The wallet's balance on this network, read again every few seconds so the
  // page shows the funds arriving and what each step spends.
  useEffect(() => {
    if (!walletState) return
    let stopped = false
    const read = async () => {
      if (typeof document !== 'undefined' && document.hidden) return
      try {
        const { native } = await client.balances({ wallet: walletState.address as `0x${string}` })
        if (!stopped) setBalance(native)
      } catch {
        // A missed read is tried again on the next tick.
      }
    }
    read()
    const timer = setInterval(read, 5000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [walletState, client])

  const handleCreate = useCallback(async () => {
    setCreateStatus('loading')
    setCreateError('')
    try {
      const rpId = typeof window !== 'undefined' ? window.location.hostname : 'localhost'
      const result = await client.createPasskeyWallet({ name: 'Altana Docs', rpId })
      setBalance(null)
      setWalletState({ wallet: result as any, address: result.address })
      setCreateStatus('done')
    } catch (e: any) {
      setCreateError(e?.message ?? String(e))
      setCreateStatus('error')
    }
  }, [client])

  const handleExecute = useCallback(async () => {
    if (!walletState) return
    setTxStatus('loading')
    setTxError('')
    try {
      const result = await client.execute({
        wallet: walletState.wallet,
        signer: walletState.wallet.signer,
        calls: { to: walletState.address as `0x${string}`, value: 0n },
      })
      setTxHash(result.transactionHash ?? result.callsId)
      setActivated(true)
      setTxStatus('done')
    } catch (e: any) {
      setTxError(e?.message ?? String(e))
      setTxStatus('error')
    }
  }, [walletState, client])

  const handleSession = useCallback(async () => {
    if (!walletState) return
    setSessionStatus('loading')
    setSessionError('')
    try {
      const session = await client.grantSession({
        wallet: walletState.wallet,
        signer: walletState.wallet.signer,
        permissions: {
          calls: [{ to: walletState.address as `0x${string}` }],
          spend: [{ limit: SESSION_SPEND_LIMIT, period: 'day' }],
        },
        expiry: Math.floor(Date.now() / 1000) + SESSION_LIFETIME_SECS,
      })
      if (session.status !== 'granted') {
        throw new Error(session.legs.filter((l) => l.status === 'FAILED').map((l) => l.reason).join('; '))
      }
      setSessionHash(session.legs.find((l) => l.transactionHash)?.transactionHash ?? '')
      setSessionStatus('done')
    } catch (e: any) {
      setSessionError(e?.message ?? String(e))
      setSessionStatus('error')
    }
  }, [walletState, client])

  const handleRecover = useCallback(async () => {
    setRecoverStatus('loading')
    setRecoverError('')
    try {
      const rpId = typeof window !== 'undefined' ? window.location.hostname : 'localhost'
      const result = await client.recoverFromPasskey({ rpId })
      // A recovered wallet is already in the Keystore, so it goes straight to
      // the steps above: its balance shows and it can create a session key.
      const address = getAddress(result.address)
      setBalance(null)
      setWalletState({ wallet: result as any, address })
      setActivated(true)
      setSessionStatus('idle')
      setSessionHash('')
      setSessionError('')
      setRecoveredAddress(address)
      setRecoverStatus('done')
    } catch (e: any) {
      setRecoverError(e?.message ?? String(e))
      setRecoverStatus('error')
    }
  }, [client])

  return (
    <div style={{ margin: '2rem 0' }}>
      <StepCard
        number={1}
        title={<>Create a passkey wallet on <NetworkBadge network={network} /></>}
        description="Your browser will prompt for biometric confirmation (Face ID, Touch ID, or your platform authenticator). The private key is generated inside your device's secure hardware and never leaves it."
        completed={createStatus === 'done'}
      >
        <AltanaButton onClick={handleCreate} loading={createStatus === 'loading'} disabled={walletState !== null}>
          Create wallet
        </AltanaButton>
        {createStatus !== 'done' ? (
          <StatusBox status={createStatus}>
            {createStatus === 'loading' && 'Waiting for biometric confirmation…'}
            {createStatus === 'error' && createError}
          </StatusBox>
        ) : (
          <div style={successBox}>
            <span style={{ flex: 1, wordBreak: 'break-all' }}>✓ Wallet created on {network.label}: {walletState?.address}</span>
            {walletState?.address && <CopyButton text={walletState.address} />}
          </div>
        )}
      </StepCard>

      <StepCard
        number={2}
        title={<>Fund the wallet on <NetworkBadge network={network} /></>}
        description={<>Send {network.symbol} to the wallet's address on {network.label}. About $1.50 is enough to activate the wallet and create a session key.</>}
        completed={funded}
      >
        {walletState ? (
          <>
            <div style={{
              padding: '0.75rem 1rem', border: '1px solid var(--vocs-color_border)', borderRadius: '6px',
              fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: '0.25rem',
            }}>
              <span style={{ flex: 1, wordBreak: 'break-all', color: 'var(--vocs-color_heading)' }}>{walletState.address}</span>
              <CopyButton text={walletState.address} />
            </div>
            <p style={{ ...note, ...(funded ? { color: '#065f46' } : {}) }}>
              {balance === null
                ? 'Checking the balance…'
                : funded
                  ? `✓ Funded. Balance: ${formatAmount(balance)} ${network.symbol}`
                  : `Balance: 0 ${network.symbol}. Waiting for funds…`}
            </p>
          </>
        ) : (
          <p style={{ ...note, marginTop: 0 }}>The wallet's address shows here once it is created.</p>
        )}
      </StepCard>

      <StepCard
        number={3}
        title={<>Activate the wallet on <NetworkBadge network={network} /></>}
        description={<>The first transaction registers your passkey's public key in Altana's onchain Keystore and activates the wallet.<br/><br/>You will see one more biometric prompt. That is your passkey signing the transaction.</>}
        completed={activated}
      >
        <AltanaButton
          onClick={handleExecute}
          loading={txStatus === 'loading'}
          disabled={!walletState || activated}
        >
          Activate wallet
        </AltanaButton>
        {txStatus === 'done' ? (
          <TxConfirmed hash={txHash} label="Transaction confirmed" explorerUrl={network.explorerUrl} />
        ) : activated ? (
          <p style={{ ...note, color: '#065f46' }}>✓ This wallet is already active.</p>
        ) : (
          <StatusBox status={txStatus}>
            {txStatus === 'loading' && 'Waiting for biometric confirmation and onchain confirmation…'}
            {txStatus === 'error' && txError}
          </StatusBox>
        )}
      </StepCard>

      <StepCard
        number={4}
        title={<>Create a session key on <NetworkBadge network={network} /></>}
        description={<>A session key is a separate key for an agent or an app, so your passkey is never shared. This one expires in one hour, can spend up to 0.001 {network.symbol} a day, and can only call this wallet.<br/><br/>Your passkey approves it with one more biometric prompt.</>}
        completed={sessionStatus === 'done'}
      >
        <AltanaButton
          onClick={handleSession}
          loading={sessionStatus === 'loading'}
          disabled={!walletState || !activated || sessionStatus === 'done'}
        >
          Create session key
        </AltanaButton>
        {sessionStatus !== 'done' ? (
          <StatusBox status={sessionStatus}>
            {sessionStatus === 'loading' && 'Waiting for biometric confirmation and for the key to be registered in the Keystore…'}
            {sessionStatus === 'error' && sessionError}
          </StatusBox>
        ) : (
          <>
            {sessionHash ? (
              <TxConfirmed hash={sessionHash} label="Session key registered in the Keystore" explorerUrl={network.explorerUrl} />
            ) : (
              <div style={successBox}>
                <span style={{ flex: 1 }}>✓ Session key registered in the Keystore</span>
              </div>
            )}
            {walletState && (
              <p style={note}>
                <a href={`${KEYSTORE_EXPLORER}/account/${walletState.address}`} target="_blank" rel="noreferrer">
                  See this wallet's keys in the Keystore Explorer
                </a>
              </p>
            )}
          </>
        )}
      </StepCard>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', margin: '0.5rem 0' }}>
        <div style={{ flex: 1, height: '1px', background: 'var(--vocs-color_border)' }} />
        <span style={{ fontSize: '0.8rem', color: 'var(--vocs-color_text2)', whiteSpace: 'nowrap' }}>or, recover an existing wallet</span>
        <div style={{ flex: 1, height: '1px', background: 'var(--vocs-color_border)' }} />
      </div>

      <StepCard
        number={5}
        title={<>Recover from passkey on <NetworkBadge network={network} /></>}
        description="Recovery matches your passkey's private key (held on your device, synced via iCloud or Google) against the public key registered onchain in the Keystore. Both halves are needed. No seed phrase, no server."
        completed={recoverStatus === 'done'}
      >
        <AltanaButton
          onClick={handleRecover}
          loading={recoverStatus === 'loading'}
          disabled={recoverStatus === 'done'}
        >
          Recover wallet
        </AltanaButton>
        {recoverStatus !== 'done' ? (
          <StatusBox status={recoverStatus}>
            {recoverStatus === 'loading' && 'Showing passkey picker…'}
            {recoverStatus === 'error' && recoverError}
          </StatusBox>
        ) : (
          <div style={successBox}>
            <span style={{ flex: 1, wordBreak: 'break-all' }}>✓ Recovered on {network.label}: {recoveredAddress}</span>
            <CopyButton text={recoveredAddress} />
          </div>
        )}
      </StepCard>
    </div>
  )
}
