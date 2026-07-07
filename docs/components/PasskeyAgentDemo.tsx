import { useState, useCallback, useRef, useEffect } from 'react'
import { createClient, BNB } from '@altananetwork/sdk'
import type { Wallet, Signer, Session } from '@altananetwork/sdk'
import { createPublicClient, http, formatEther } from 'viem'
import { bsc } from 'viem/chains'

const client = createClient({ chains: [BNB] })
const publicClient = createPublicClient({ chain: bsc, transport: http('https://bsc-rpc.publicnode.com') })

type StepStatus = 'idle' | 'loading' | 'done' | 'error'

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
    }}>
      {status === 'loading' && '⏳ '}
      {status === 'done' && '✓ '}
      {status === 'error' && '✗ '}
      {children}
    </div>
  )
}

function TxConfirmed({ hash, label }: { hash: string; label: string }) {
  return (
    <div style={{
      marginTop: '0.75rem', padding: '0.75rem 1rem', background: '#d1fae5',
      borderRadius: '6px', fontSize: '0.875rem', color: '#065f46',
      fontFamily: 'var(--vocs-fontFamily_mono)', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap',
    }}>
      <span style={{ flex: 1, wordBreak: 'break-all' }}>✓ {label}: {hash}</span>
      <a
        href={`https://bscscan.com/tx/${hash}`}
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
  )
}

function StepCard({ number, title, description, children, completed }: {
  number: number
  title: string
  description: React.ReactNode
  children: React.ReactNode
  completed?: boolean
}) {
  return (
    <div style={{
      display: 'flex',
      gap: '1.25rem',
      padding: '1.5rem',
      border: `1px solid ${completed ? '#6ee7b7' : 'var(--vocs-color_border)'}`,
      borderRadius: '8px',
      margin: '1rem 0',
      transition: 'border-color 0.2s',
    }}>
      <div style={{
        flexShrink: 0,
        width: '2rem',
        height: '2rem',
        borderRadius: '50%',
        background: completed ? '#10b981' : '#3665E4',
        color: 'var(--vocs-color_background)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: '700',
        fontSize: '0.875rem',
      }}>
        {completed ? '✓' : number}
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

type WalletState = { wallet: Wallet & { signer: Signer }; address: string } | null

export function PasskeyAgentDemo() {
  const [walletState, setWalletState] = useState<WalletState>(null)
  const [createStatus, setCreateStatus] = useState<StepStatus>('idle')
  const [createError, setCreateError] = useState('')
  const [balance, setBalance] = useState<bigint | null>(null)
  const balancePollRef = useRef<ReturnType<typeof setInterval>>()

  const funded = balance !== null && balance > 0n

  useEffect(() => {
    if (!walletState || createStatus !== 'done' || funded) return
    const poll = async () => {
      try {
        const b = await publicClient.getBalance({ address: walletState.address as `0x${string}` })
        setBalance(b)
        if (b > 0n) clearInterval(balancePollRef.current)
      } catch {}
    }
    poll()
    balancePollRef.current = setInterval(poll, 3000)
    return () => clearInterval(balancePollRef.current)
  }, [walletState, createStatus, funded])

  const [session, setSession] = useState<Session | null>(null)
  const [grantStatus, setGrantStatus] = useState<StepStatus>('idle')
  const [grantError, setGrantError] = useState('')

  const [execStatus, setExecStatus] = useState<StepStatus>('idle')
  const [execHash, setExecHash] = useState('')
  const [execError, setExecError] = useState('')

  const [revokeStatus, setRevokeStatus] = useState<StepStatus>('idle')
  const [revokeHash, setRevokeHash] = useState('')
  const [revokeError, setRevokeError] = useState('')

  const handleCreate = useCallback(async () => {
    setCreateStatus('loading')
    setCreateError('')
    try {
      const rpId = typeof window !== 'undefined' ? window.location.hostname : 'localhost'
      const result = await client.createPasskeyWallet({ name: 'Altana Docs Agent Demo', rpId })
      setWalletState({ wallet: result as any, address: result.address })
      setCreateStatus('done')
    } catch (e: any) {
      setCreateError(e?.message ?? String(e))
      setCreateStatus('error')
    }
  }, [])

  const handleRecover = useCallback(async () => {
    setCreateStatus('loading')
    setCreateError('')
    try {
      const rpId = typeof window !== 'undefined' ? window.location.hostname : 'localhost'
      const result = await client.recoverFromPasskey({ rpId })
      setWalletState({ wallet: result as any, address: result.address })
      setCreateStatus('done')
    } catch (e: any) {
      setCreateError(e?.message ?? String(e))
      setCreateStatus('error')
    }
  }, [])

  const handleGrant = useCallback(async () => {
    if (!walletState) return
    setGrantStatus('loading')
    setGrantError('')
    try {
      const s = await client.grantSession({
        wallet: walletState.wallet,
        signer: walletState.wallet.signer,
        permissions: {
          calls: [{ to: walletState.address as `0x${string}` }],
          spend: [{ limit: 1_000_000_000_000_000n, period: 'day' }],
        },
        expiry: Math.floor(Date.now() / 1000) + 60 * 60, // 1 hour
      })
      setSession(s)
      setGrantStatus('done')
    } catch (e: any) {
      setGrantError(e?.message ?? String(e))
      setGrantStatus('error')
    }
  }, [walletState])

  const handleAgentExecute = useCallback(async () => {
    if (!session) return
    setExecStatus('loading')
    setExecError('')
    try {
      const result = await client.execute({
        session,
        calls: { to: session.walletAddress as `0x${string}`, value: 0n },
      })
      setExecHash(result.transactionHash ?? result.callsId)
      setExecStatus('done')
    } catch (e: any) {
      setExecError(e?.message ?? String(e))
      setExecStatus('error')
    }
  }, [session])

  const handleRevoke = useCallback(async () => {
    if (!walletState || !session) return
    setRevokeStatus('loading')
    setRevokeError('')
    try {
      const result = await client.revokeSession({
        wallet: walletState.wallet,
        signer: walletState.wallet.signer,
        session,
      })
      setRevokeHash(result.transactionHash ?? result.callsId)
      setRevokeStatus('done')
    } catch (e: any) {
      setRevokeError(e?.message ?? String(e))
      setRevokeStatus('error')
    }
  }, [walletState, session])

  return (
    <div style={{ margin: '2rem 0' }}>
      <StepCard
        number={1}
        title="Set up your passkey wallet (you are the admin)"
        description={<>Your passkey secures the wallet.<br/>Create a new one, or sign in with an existing passkey wallet.</>}
        completed={createStatus === 'done'}
      >
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <AltanaButton onClick={handleCreate} loading={createStatus === 'loading'} disabled={createStatus === 'done'}>
            Create wallet
          </AltanaButton>
          <button
            onClick={handleRecover}
            disabled={createStatus === 'loading' || createStatus === 'done'}
            style={{
              background: 'transparent',
              border: '1px solid var(--vocs-color_border)',
              borderRadius: '6px',
              padding: '0.6rem 1.1rem',
              fontWeight: 600,
              fontSize: '0.9rem',
              cursor: createStatus === 'loading' || createStatus === 'done' ? 'not-allowed' : 'pointer',
              color: 'inherit',
              opacity: createStatus === 'loading' || createStatus === 'done' ? 0.5 : 1,
            }}
          >
            Sign in with existing passkey
          </button>
        </div>
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
            <span style={{ flex: 1, wordBreak: 'break-all' }}>✓ Admin wallet: {walletState?.address}</span>
            {walletState?.address && <CopyButton text={walletState.address} />}
          </div>
        )}
        {createStatus === 'done' && !funded && (
          <p style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: 'var(--vocs-color_text2)' }}>
            Fund this address with at least <strong>0.05 BNB</strong> to cover steps 2–4 (~0.012 BNB per transaction).
            {' '}— checking balance…
          </p>
        )}
        {createStatus === 'done' && funded && (
          <p style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: '#065f46' }}>
            ✓ Funded ({formatEther(balance!).slice(0, 8)} BNB) — ready for step 2
          </p>
        )}
      </StepCard>

      <StepCard
        number={2}
        title="Grant a scoped session to the agent"
        description={<>The agent gets a separate key, not yours.<br/>It can only act within the permissions you set here: one hour expiry, 0.001 BNB daily spend cap, only calls back to the same wallet. Your passkey signs the grant.</>}
        completed={grantStatus === 'done'}
      >
        <AltanaButton
          onClick={handleGrant}
          loading={grantStatus === 'loading'}
          disabled={createStatus !== 'done' || !funded || grantStatus === 'done'}
        >
          Grant session
        </AltanaButton>
        {grantStatus !== 'done' ? (
          <StatusBox status={grantStatus}>
            {grantStatus === 'loading' && 'Registering agent key in Keystore…'}
            {grantStatus === 'error' && grantError}
          </StatusBox>
        ) : (
          <div style={{
            marginTop: '0.75rem', padding: '0.75rem 1rem', background: '#d1fae5',
            borderRadius: '6px', fontSize: '0.875rem', color: '#065f46',
            fontFamily: 'var(--vocs-fontFamily_mono)', display: 'flex', alignItems: 'center', gap: '0.5rem',
          }}>
            <span style={{ flex: 1, wordBreak: 'break-all' }}>✓ Session key registered in Keystore</span>
            <a
              href={`https://bscscan.com/address/${walletState?.address}`}
              target="_blank"
              rel="noreferrer"
              title="View wallet transactions"
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

      <StepCard
        number={3}
        title="The agent executes — no passkey involved"
        description="The agent uses its own session key to sign this transaction. Your passkey is not touched. The onchain validator checks the session's permissions before the call goes through."
        completed={execStatus === 'done'}
      >
        <AltanaButton
          onClick={handleAgentExecute}
          loading={execStatus === 'loading'}
          disabled={grantStatus !== 'done' || execStatus === 'done'}
        >
          Execute as agent
        </AltanaButton>
        {execStatus !== 'done' ? (
          <StatusBox status={execStatus}>
            {execStatus === 'loading' && 'Agent signing and submitting…'}
            {execStatus === 'error' && execError}
          </StatusBox>
        ) : (
          <TxConfirmed hash={execHash} label="Agent transaction confirmed" />
        )}
      </StepCard>

      <StepCard
        number={4}
        title="Revoke the session — one transaction"
        description="You, the admin, pull the agent's key from Keystore. The effect is immediate and global. The agent's next call will revert at validation. No off-chain coordination required."
        completed={revokeStatus === 'done'}
      >
        <AltanaButton
          onClick={handleRevoke}
          loading={revokeStatus === 'loading'}
          disabled={execStatus !== 'done' || revokeStatus === 'done'}
        >
          Revoke session
        </AltanaButton>
        {revokeStatus !== 'done' ? (
          <StatusBox status={revokeStatus}>
            {revokeStatus === 'loading' && 'Revoking agent key in Keystore…'}
            {revokeStatus === 'error' && revokeError}
          </StatusBox>
        ) : (
          <TxConfirmed hash={revokeHash} label="Session revoked" />
        )}
      </StepCard>
    </div>
  )
}
