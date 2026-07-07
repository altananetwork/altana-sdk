import { Fragment } from 'react'
import type { ReactNode } from 'react'

type Tool = 'SDK' | 'MCP' | 'AI Chat'
type Row = { label: string; value: ReactNode }

const defaultToolLinks: Record<Tool, string> = {
  SDK: '/getting-started/create-agentic-wallet#private-key',
  MCP: '/getting-started/build-with-claude',
  'AI Chat': '/getting-started/build-with-claude',
}

const toolStyles: Record<Tool, { background: string; color: string; border: string }> = {
  SDK: {
    background: 'rgba(59, 130, 246, 0.10)',
    color: '#3b82f6',
    border: '1px solid rgba(59, 130, 246, 0.25)',
  },
  MCP: {
    background: 'rgba(139, 92, 246, 0.10)',
    color: '#8b5cf6',
    border: '1px solid rgba(139, 92, 246, 0.25)',
  },
  'AI Chat': {
    background: 'rgba(34, 197, 94, 0.10)',
    color: '#22c55e',
    border: '1px solid rgba(34, 197, 94, 0.25)',
  },
}

export function UseCaseMeta({
  rows,
  tools,
  toolLinks,
}: {
  rows: Row[]
  tools?: Tool[]
  toolLinks?: Partial<Record<Tool, string>>
}) {
  const resolvedLinks = { ...defaultToolLinks, ...toolLinks }

  const toolRow: Row | null = tools?.length
    ? {
        label: 'What you need',
        value: (
          <span style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', paddingTop: '0.1rem' }}>
            {tools.map(tool => (
              <a
                key={tool}
                href={resolvedLinks[tool]}
                style={{
                  display: 'inline-block',
                  padding: '0.15rem 0.65rem',
                  borderRadius: '999px',
                  fontSize: '0.78rem',
                  fontWeight: 600,
                  letterSpacing: '0.02em',
                  textDecoration: 'none',
                  ...toolStyles[tool],
                }}
              >
                {tool}
              </a>
            ))}
          </span>
        ),
      }
    : null

  const allRows = toolRow ? [toolRow, ...rows] : rows

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'max-content 1fr',
      columnGap: '2rem',
      rowGap: '0.6rem',
      margin: '1.75rem 0 2rem',
    }}>
      {allRows.map(({ label, value }) => (
        <Fragment key={label}>
          <div style={{
            fontSize: '0.78rem',
            fontWeight: 600,
            color: 'var(--vocs-color_textSecondary)',
            textTransform: 'uppercase',
            letterSpacing: '0.07em',
            whiteSpace: 'nowrap',
            paddingTop: '0.2rem',
          }}>
            {label}
          </div>
          <div style={{ lineHeight: 1.65, fontSize: '0.9375rem' }}>
            {value}
          </div>
        </Fragment>
      ))}
    </div>
  )
}
