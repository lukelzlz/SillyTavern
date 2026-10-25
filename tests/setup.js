import path from 'node:path';
import { setConfigFilePath } from '../src/util.js';

// Keep isolated Jest invocations deterministic. Several server modules read
// configuration during import, so every worker must initialize the same
// repository-local default config before loading a test file.
setConfigFilePath(path.resolve(process.cwd(), '../default/config.yaml'));
