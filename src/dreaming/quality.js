/**
 * Confidence scoring for skill generation candidates.
 *
 * Score range: 0.0 – 1.0
 *   base       0.5
 *   +0.1/block for tool_use blocks beyond 5 (max +0.3)
 *   +0.1 if user expressed satisfaction
 *   −0.2 if user expressed failure/frustration
 */

const SATISFACTION_SIGNALS = ['thanks', 'thank you', 'perfect', 'done', 'great', 'exactly', '✓', '👍'];
const FAILURE_SIGNALS = ["didn't work", "doesn't work", "wrong", "that's not", 'not what i', 'try again', 'no,', 'incorrect'];

export function scoreThread({ toolUseTotal, messages }) {
  let score = 0.5;

  // Tool use depth bonus
  const extra = Math.min(toolUseTotal - 5, 3); // cap at +0.3
  if (extra > 0) score += extra * 0.1;

  // Sentiment signals from the last 10 user messages
  const recent = messages
    .filter((m) => m.role === 'user')
    .slice(-10)
    .map((m) => m.content.toLowerCase());

  const satisfied = recent.some((t) => SATISFACTION_SIGNALS.some((s) => t.includes(s)));
  const failed = recent.some((t) => FAILURE_SIGNALS.some((s) => t.includes(s)));

  if (satisfied) score += 0.1;
  if (failed) score -= 0.2;

  return Math.max(0, Math.min(1, score));
}
