import { useState, useCallback, useEffect } from 'react'
import { createClient } from '@altananetwork/sdk'
import type { Wallet, Signer } from '@altananetwork/sdk'
import { AltanaButton, CopyButton, StatusBox, StepCard, TxConfirmed } from './demo/primitives'
import type { StepStatus } from './demo/primitives'
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

  const [txStatus, setTxStatus] = useState<StepStatus>('idle')
  const [txHash, setTxHash] = useState('')
  const [txError, setTxError] = useState('')

  const [recoverStatus, setRecoverStatus] = useState<StepStatus>('idle')
  const [recoveredAddress, setRecoveredAddress] = useState('')
  const [recoverError, setRecoverError] = useState('')

  const handleCreate = useCallback(async () => {
    setCreateStatus('loading')
    setCreateError('')
    try {
      const rpId = typeof window !== 'undefined' ? window.location.hostname : 'localhost'
      const result = await client.createPasskeyWallet({ name: 'Altana Docs', rpId })
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
      setTxStatus('done')
    } catch (e: any) {
      setTxError(e?.message ?? String(e))
      setTxStatus('error')
    }
  }, [walletState, client])

  const handleRecover = useCallback(async () => {
    setRecoverStatus('loading')
    setRecoverError('')
    try {
      const rpId = typeof window !== 'undefined' ? window.location.hostname : 'localhost'
      const result = await client.recoverFromPasskey({ rpId })
      setRecoveredAddress(result.address)
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
      >
        <AltanaButton onClick={handleCreate} loading={createStatus === 'loading'} disabled={createStatus === 'done'}>
          Create wallet
        </AltanaButton>
        {createStatus !== 'done' ? (
          <StatusBox status={createStatus}>
            {createStatus === 'loading' && 'Waiting for biometric confirmation…'}
            {createStatus === 'error' && createError}
          </StatusBox>
        ) : (
          <div style={{
            marginTop: '0.75rem', padding: '0.75rem 1rem', background: '#d1fae5',
            borderRadius: '6px', fontSize: '0.875rem', color: '#065f46',
            fontFamily: 'var(--vocs-fontFamily_mono)', display: 'flex', alignItems: 'center', gap: '0.25rem',
          }}>
            <span style={{ flex: 1, wordBreak: 'break-all' }}>✓ Wallet created on {network.label}: {walletState?.address}</span>
            {walletState?.address && <CopyButton text={walletState.address} />}
          </div>
        )}
        {createStatus === 'done' && (
          <p style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: 'var(--vocs-color_text2)' }}>
            Fund this address on {network.label} to continue. We recommend around <strong>$5</strong> of {network.symbol}.
          </p>
        )}
      </StepCard>

      <StepCard
        number={2}
        title={<>Activate the wallet on <NetworkBadge network={network} /></>}
        description={<>The first transaction registers your passkey's public key in Altana's onchain Keystore and activates the wallet.<br/><br/>You will see one more biometric prompt. That is your passkey signing the transaction.</>}
      >
        <AltanaButton
          onClick={handleExecute}
          loading={txStatus === 'loading'}
          disabled={!walletState || txStatus === 'done'}
        >
          Activate wallet
        </AltanaButton>
        {txStatus !== 'done' ? (
          <StatusBox status={txStatus}>
            {txStatus === 'loading' && 'Waiting for biometric confirmation and onchain confirmation…'}
            {txStatus === 'error' && txError}
          </StatusBox>
        ) : (
          <TxConfirmed hash={txHash} label="Transaction confirmed" explorerUrl={network.explorerUrl} />
        )}
      </StepCard>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', margin: '0.5rem 0' }}>
        <div style={{ flex: 1, height: '1px', background: 'var(--vocs-color_border)' }} />
        <span style={{ fontSize: '0.8rem', color: 'var(--vocs-color_text2)', whiteSpace: 'nowrap' }}>or, recover an existing wallet</span>
        <div style={{ flex: 1, height: '1px', background: 'var(--vocs-color_border)' }} />
      </div>

      <StepCard
        number={3}
        title={<>Recover from passkey on <NetworkBadge network={network} /></>}
        description="Recovery matches your passkey's private key (held on your device, synced via iCloud or Google) against the public key registered onchain in the Keystore. Both halves are needed. No seed phrase, no server."
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
          <div style={{
            marginTop: '0.75rem', padding: '0.75rem 1rem', background: '#d1fae5',
            borderRadius: '6px', fontSize: '0.875rem', color: '#065f46',
            fontFamily: 'var(--vocs-fontFamily_mono)', display: 'flex', alignItems: 'center', gap: '0.25rem',
          }}>
            <span style={{ flex: 1, wordBreak: 'break-all' }}>✓ Recovered: {recoveredAddress}</span>
            <CopyButton text={recoveredAddress} />
          </div>
        )}
      </StepCard>
    </div>
  )
}
