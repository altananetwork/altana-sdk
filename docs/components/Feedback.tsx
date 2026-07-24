import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Per-page "Was this helpful?" widget, mounted via the vocs Footer slot
 * (see ../footer.tsx) so it runs on every docs page.
 *
 * Placement: when the page has the right-hand outline rail ("On this page"),
 * the widget portals into that aside so it sits under the outline, at the
 * right of the page. On pages without the rail (showOutline: false, e.g. the
 * welcome hub), it renders inline in the footer, at the end of the page.
 *
 * Flow: thumbs up/down -> a short survey (positive or negative variant) ->
 * submit -> thank-you state. Submissions are sent as Vercel Web Analytics
 * custom events (window.va), matching the analytics already wired in
 * vocs.config.ts. If analytics is unavailable the calls no-op.
 *
 * State resets on client-side route changes. Vocs re-renders in place on
 * navigation, so we track the pathname ourselves and reset when it changes.
 * A path that was already rated shows the thank-you state again.
 */

type Sentiment = 'up' | 'down'
type Stage = 'ask' | 'survey' | 'done'

const positiveReasons = [
  'Accurate',
  'Easy to understand',
  'Solved my problem',
  'Helped me decide to use the product',
  'Other',
]

const negativeReasons = [
  'Inaccurate',
  'Hard to understand',
  'Missing information',
  'Outdated',
  'Other',
]

const storageKey = (path: string) => `altana.feedback:${path}`

function track(name: string, data: Record<string, string>) {
  try {
    ;(window as unknown as { va?: (e: string, p: unknown) => void }).va?.('event', {
      name,
      data,
    })
  } catch {
    // Analytics is best-effort; never let it break the UI.
  }
}

/** Emit a single event and patch the History API so client nav is observable. */
function usePathname() {
  const [path, setPath] = useState(() =>
    typeof window === 'undefined' ? '/' : window.location.pathname,
  )

  useEffect(() => {
    const update = () => setPath(window.location.pathname)
    update()

    const wrap = (type: 'pushState' | 'replaceState') => {
      const original = history[type]
      return function (this: History, ...args: Parameters<History['pushState']>) {
        const result = original.apply(this, args)
        window.dispatchEvent(new Event('altana:locationchange'))
        return result
      }
    }
    history.pushState = wrap('pushState')
    history.replaceState = wrap('replaceState')

    window.addEventListener('popstate', update)
    window.addEventListener('altana:locationchange', update)
    return () => {
      window.removeEventListener('popstate', update)
      window.removeEventListener('altana:locationchange', update)
    }
  }, [])

  return path
}

export function Feedback() {
  const path = usePathname()
  const [stage, setStage] = useState<Stage>('ask')
  const [sentiment, setSentiment] = useState<Sentiment | null>(null)
  const [reason, setReason] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const surveyRef = useRef<HTMLDivElement>(null)

  // Portal target: the outline aside, when the page has one. A dedicated
  // container is appended as the last child of the aside so the widget sits
  // below "On this page" without interleaving vocs's own outline nodes.
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const slotRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const aside = document.querySelector<HTMLElement>('.vocs_Outline')
    if (!aside) {
      setSlot(null)
      return
    }
    const container = slotRef.current ?? document.createElement('div')
    slotRef.current = container
    container.className = 'altana-feedback-slot'
    aside.appendChild(container)
    setSlot(container)
    return () => {
      container.remove()
    }
  }, [path])

  // Reset (or restore) state whenever the page changes.
  useEffect(() => {
    setReason(null)
    setComment('')
    let alreadyRated: string | null = null
    try {
      alreadyRated = localStorage.getItem(storageKey(path))
    } catch {
      // ignore storage failures (private mode, etc.)
    }
    if (alreadyRated === 'up' || alreadyRated === 'down') {
      setSentiment(alreadyRated)
      setStage('done')
    } else {
      setSentiment(null)
      setStage('ask')
    }
  }, [path])

  const choose = (value: Sentiment) => {
    setSentiment(value)
    setStage('survey')
    track('docs_feedback_vote', { page: path, sentiment: value })
    // Move focus into the survey for keyboard/screen-reader users.
    requestAnimationFrame(() => surveyRef.current?.focus())
  }

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!sentiment) return
    track('docs_feedback_survey', {
      page: path,
      sentiment,
      reason: reason ?? '(none)',
      comment: comment.trim() || '(none)',
    })
    try {
      localStorage.setItem(storageKey(path), sentiment)
    } catch {
      // ignore
    }
    setStage('done')
  }

  const reasons = sentiment === 'up' ? positiveReasons : negativeReasons

  const widget = (
    <section
      className={`altana-feedback altana-feedback--${slot ? 'outline' : 'footer'}`}
      aria-label="Page feedback"
    >
      {stage === 'ask' && (
        <>
          <p className="altana-feedback-title">Was this helpful?</p>
          <div className="altana-feedback-thumbs">
            <button
              type="button"
              className="altana-feedback-thumb"
              aria-label="Yes, this was helpful"
              onClick={() => choose('up')}
            >
              <ThumbUp />
            </button>
            <button
              type="button"
              className="altana-feedback-thumb"
              aria-label="No, this was not helpful"
              onClick={() => choose('down')}
            >
              <ThumbDown />
            </button>
          </div>
        </>
      )}

      {stage === 'survey' && (
        <form className="altana-feedback-survey" onSubmit={submit}>
          <div ref={surveyRef} tabIndex={-1} className="altana-feedback-title">
            {sentiment === 'up' ? 'What did you like?' : 'What went wrong?'}
          </div>
          <fieldset className="altana-feedback-options">
            <legend className="altana-visually-hidden">
              {sentiment === 'up' ? 'What did you like?' : 'What went wrong?'}
            </legend>
            {reasons.map((option) => (
              <label key={option} className="altana-feedback-option">
                <input
                  type="radio"
                  name="feedback-reason"
                  value={option}
                  checked={reason === option}
                  onChange={() => setReason(option)}
                />
                <span>{option}</span>
              </label>
            ))}
          </fieldset>
          <textarea
            className="altana-feedback-textarea"
            placeholder="Tell us more about your experience."
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            rows={3}
          />
          <button type="submit" className="altana-feedback-submit">
            Submit
          </button>
        </form>
      )}

      {stage === 'done' && (
        <p className="altana-feedback-title altana-feedback-thanks">
          Thanks for your feedback.
        </p>
      )}
    </section>
  )

  return slot ? createPortal(widget, slot) : widget
}

function ThumbUp() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 10v11" />
      <path d="M3.5 10.5A1.5 1.5 0 0 1 5 9h2v12H5a1.5 1.5 0 0 1-1.5-1.5v-9Z" />
      <path d="M7 10l4-7c.9 0 1.8.4 2.3 1.1.5.7.6 1.6.3 2.4L12.5 9H18a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 16.8 20H7" />
    </svg>
  )
}

function ThumbDown() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 14V3" />
      <path d="M20.5 13.5A1.5 1.5 0 0 1 19 15h-2V3h2a1.5 1.5 0 0 1 1.5 1.5v9Z" />
      <path d="M17 14l-4 7c-.9 0-1.8-.4-2.3-1.1-.5-.7-.6-1.6-.3-2.4L11.5 15H6a2 2 0 0 1-2-2.3l1.2-7A2 2 0 0 1 7.2 4H17" />
    </svg>
  )
}
