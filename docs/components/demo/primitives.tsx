import { useState, useRef } from 'react'

/**
 * Shared presentational primitives for the interactive demos
 * (PasskeyDemo, PasskeyAgentDemo). No SDK calls live here.
 */

export type StepStatus = 'idle' | 'loading' | 'done' | 'error'

export function AltanaButton({
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
        borderRadius: '6px',
        fontWeight: '600',
        fontSize: '0.9rem',
        cursor: disabled || loading ? 'not-allowed' : 'pointer',
        opacity: loading ? 0.75 : 1,
        transition: 'opacity 0.15s, background 0.15s',
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

export function CopyButton({ text }: { text: string }) {
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

export function StatusBox({ status, children }: { status: StepStatus; children?: React.ReactNode }) {
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

export function TxConfirmed({ hash, label }: { hash: string; label: string }) {
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

export function StepCard({ number, title, description, children, completed }: {
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
