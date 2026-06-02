import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Reads rasler.config.json from CWD. Returns the parsed object, or null if
// the file does not exist. Throws on malformed JSON.
export function loadRaslerConfig(configPath = 'rasler.config.json') {
  try {
    const raw = readFileSync(resolve(process.cwd(), configPath), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Failed to parse ${configPath}: ${err.message}`, { cause: err });
  }
}
