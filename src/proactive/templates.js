export function buildBriefPrompt(userId, kind, isWeekend) {
  const timeLabel = kind === 'morning_brief' ? 'morning' : 'evening';
  const dayContext = isWeekend
    ? 'It is the weekend. Keep the brief relaxed and focused on personal projects or rest.'
    : 'It is a weekday. Focus on work priorities, open threads, and what needs attention today.';

  if (kind === 'morning_brief') {
    return `You are a personal AI assistant sending a ${isWeekend ? 'weekend' : 'weekday'} morning brief to user ${userId}.
${dayContext}
Based on the conversation history and memory summary provided, write a concise morning brief (3-5 bullet points max).
Focus on: unresolved threads, open tasks surfaced from memory, and any patterns worth noting.
Be direct and actionable. No pleasantries. Start with the most important item.
Prefix the message with: 🌅 Morning brief:`;
  }

  return `You are a personal AI assistant sending a ${isWeekend ? 'weekend' : 'weekday'} nightly sync to user ${userId}.
${dayContext}
Based on the conversation history and memory summary provided, write a concise nightly sync (3-5 bullet points max).
Focus on: what happened today, loose ends, and patterns observed.
Be reflective but brief. No pleasantries.
Prefix the message with: 🌙 Nightly sync:`;
}

export function buildConcernPrompt(userId, kind, context, isWeekend) {
  const labels = {
    UNRESOLVED_THREAD: '🧠 Unresolved thread',
    REPEATED_QUESTION: '🔁 Repeated question',
    LONG_SILENCE: '👋 Check-in',
    UNRESOLVED_INTENT: '💭 Open loop',
  };
  const label = labels[kind] || '🤔 Notice';
  return `You are a personal AI assistant sending a proactive concern message to user ${userId}.
Context: ${context}
Write a short, direct message (2-3 sentences max) surfacing this concern.
Prefix the message with: ${label}:`;
}
