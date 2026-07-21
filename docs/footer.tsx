import { Feedback } from './components/Feedback'

/**
 * Rendered by vocs inside its Footer on every page (via the
 * `virtual:consumer-components` Footer slot). Styles in styles.css use
 * `order: -1` to lift the feedback widget above the edit link and prev/next
 * navigation within the footer's flex column.
 */
export default function Footer() {
  return <Feedback />
}
