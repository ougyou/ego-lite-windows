const ENGINES = new Map();

export function registerEngine(name, adapter) {
  ENGINES.set(name, adapter);
}

export function getEngine(name) {
  const engine = ENGINES.get(name);
  if (!engine) {
    const available = [...ENGINES.keys()].join(", ") || "(none)";
    throw new Error(`vision: unknown OCR engine "${name}". Available: ${available}`);
  }
  return engine;
}
