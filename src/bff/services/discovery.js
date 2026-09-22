export function discoveryTarget(value, mode = 'auto') {
  const q = String(value || '').trim();
  if (!q || q.length > 4000) throw new Error('Enter a question or keywords between 1 and 4,000 characters.');
  if (!['auto', 'ask', 'search'].includes(mode)) throw new Error('Choose Auto, Ask or Search.');
  const question = mode === 'ask' || (mode === 'auto' &&
    (/\?\s*$/.test(q) || /^(who|what|when|where|why|how|which|can|could|should|would|is|are|do|does|tell me|help me|explain)\b/i.test(q)));
  return { q, mode: question ? 'ask' : 'search', path: question ? '/ask' : '/cortex' };
}
