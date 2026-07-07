import { useState, useCallback, useRef } from 'react'
import { createClient, BNB } from '@altananetwork/sdk'
import type { Wallet, Signer } from '@altananetwork/sdk'

const client = createClient({ chains: [BNB] })

type StepStatus = 'idle' | 'loading' | 'done' | 'error'

type WalletState = {
  wallet: Wallet & { signer: Signer }
  address: string
} | null

// ── shared UI ────────────────────────────────────────────────────────────────

function AltanaButton({
  onClick,
  disabled,
  loading,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  loading?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className="altana-cta"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.5rem',
        padding: '0.6rem 1.1rem',
        background: disabled || loading ? 'var(--vocs-color_border)' : '#3665E4',
        color: '#fff',
        border: 'none',
        borderRadius: '6px',
        fontWeight: '600',
        fontSize: '0.9rem',
        cursor: disabled || loading ? 'not-allowed' : 'pointer',
        opacity: loading ? 0.75 : 1,
        transition: 'opacity 0.15s',
      }}
    >
      <img
        src="/altana-icon.png"
        alt=""
        style={{ width: '1.4em', height: '1.4em', flexShrink: 0 }}
      />
      {loading ? 'Working…' : children}
    </button>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const copy = () => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button onClick={copy} title={copied ? 'Copied!' : 'Copy address'} style={{
      display: 'inline-flex', alignItems: 'center', background: 'none', border: 'none',
      cursor: 'pointer', padding: '0 0 0 6px', color: copied ? '#10b981' : 'inherit', flexShrink: 0,
    }}>
      {copied ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      )}
    </button>
  )
}

function StatusBox({ status, children }: { status: StepStatus; children?: React.ReactNode }) {
  if (status === 'idle') return null
  const colors: Record<StepStatus, string> = {
    idle: 'transparent',
    loading: 'var(--vocs-color_border)',
    done: '#d1fae5',
    error: '#fee2e2',
  }
  const textColors: Record<StepStatus, string> = {
    idle: 'inherit',
    loading: 'var(--vocs-color_text2)',
    done: '#065f46',
    error: '#991b1b',
  }
  return (
    <div style={{
      marginTop: '0.75rem',
      padding: '0.75rem 1rem',
      background: colors[status],
      borderRadius: '6px',
      fontSize: '0.875rem',
      color: textColors[status],
      fontFamily: status === 'loading' ? 'inherit' : 'var(--vocs-fontFamily_mono)',
      wordBreak: 'break-all',
      display: 'flex',
      alignItems: 'center',
    }}>
      <span style={{ flex: 1 }}>
        {status === 'loading' && '⏳ '}
        {status === 'done' && '✓ '}
        {status === 'error' && '✗ '}
        {children}
      </span>
    </div>
  )
}

function StepCard({ number, title, description, children }: {
  number: number
  title: string
  description: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div style={{
      display: 'flex',
      gap: '1.25rem',
      padding: '1.5rem',
      border: '1px solid var(--vocs-color_border)',
      borderRadius: '8px',
      margin: '1rem 0',
    }}>
      <div style={{
        flexShrink: 0,
        width: '2rem',
        height: '2rem',
        borderRadius: '50%',
        background: 'var(--vocs-color_heading)',
        color: 'var(--vocs-color_background)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: '700',
        fontSize: '0.875rem',
      }}>
        {number}
      </div>
      <div style={{ flex: 1 }}>
        <p style={{ margin: '0 0 0.3rem', fontWeight: '700', fontSize: '1rem', color: 'var(--vocs-color_heading)' }}>
          {title}
        </p>
        <p style={{ margin: '0 0 0.85rem', fontSize: '0.9rem', color: 'var(--vocs-color_text2)', lineHeight: 1.6 }}>
          {description}
        </p>
        {children}
      </div>
    </div>
  )
}

// ── main demo ────────────────────────────────────────────────────────────────

export function PasskeyDemo() {
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
  }, [])

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
  }, [walletState])

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
  }, [])

  return (
    <div style={{ margin: '2rem 0' }}>
      <StepCard
        number={1}
        title="Create a passkey wallet"
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
            <span style={{ flex: 1, wordBreak: 'break-all' }}>✓ Wallet created: {walletState?.address}</span>
            {walletState?.address && <CopyButton text={walletState.address} />}
          </div>
        )}
        {createStatus === 'done' && (
          <p style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: 'var(--vocs-color_text2)' }}>
            Fund this address with BNB before step 2.
          </p>
        )}
      </StepCard>

      <StepCard
        number={2}
        title="Activate the wallet onchain"
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
          <div style={{
            marginTop: '0.75rem', padding: '0.75rem 1rem', background: '#d1fae5',
            borderRadius: '6px', fontSize: '0.875rem', color: '#065f46',
            fontFamily: 'var(--vocs-fontFamily_mono)', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap',
          }}>
            <span style={{ flex: 1, wordBreak: 'break-all' }}>✓ Transaction confirmed: {txHash}</span>
            <a
              href={`https://bscscan.com/tx/${txHash}`}
              target="_blank"
              rel="noreferrer"
              title="View in explorer"
              style={{ color: '#065f46', flexShrink: 0 }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/>
                <line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
            </a>
          </div>
        )}
      </StepCard>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', margin: '0.5rem 0' }}>
        <div style={{ flex: 1, height: '1px', background: 'var(--vocs-color_border)' }} />
        <span style={{ fontSize: '0.8rem', color: 'var(--vocs-color_text2)', whiteSpace: 'nowrap' }}>or, recover an existing wallet</span>
        <div style={{ flex: 1, height: '1px', background: 'var(--vocs-color_border)' }} />
      </div>

      <StepCard
        number={3}
        title="Recover from passkey"
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
