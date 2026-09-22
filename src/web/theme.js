const themes = {
  defra: { name: 'Defra', organisation: 'Department for Environment, Food & Rural Affairs', strapline: 'Data Driven Defra', colour: '#0b0c0c', illustration: 'brand-defra.svg' },
  microsoft: { name: 'Microsoft', organisation: 'Microsoft technology accelerator', strapline: 'Discover. Build. Share.', colour: '#0067b8', illustration: 'brand-microsoft.svg' },
  novo: { name: 'Novo Nordisk', organisation: 'Customer demonstration', strapline: 'Connected knowledge. Governed AI.', colour: '#001965', illustration: 'brand-novo.svg' }
};

export function themeFor(name = process.env.CORTEX_THEME || 'defra') {
  if (!Object.hasOwn(themes, name)) throw new Error(`Unsupported CORTEX_THEME: ${name}. Use defra, microsoft or novo.`);
  return { id: name, ...themes[name] };
}
