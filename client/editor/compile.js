// The map editor's compile worker: a project in, the BSP file out (shared/bspwriter.js
// through project.js), checked like any map from outside (parseUntrustedBSP), so what the
// editor exports or plays is a map the game takes.
//
// In:  { id, project, light: 'full' | 'draft' }
// Out: { id, bytes (transferred), stats, ms } | { id, error }

import { compileProject } from './project.js';
import { parseUntrustedBSP } from '../../shared/bsp.js';

onmessage = (e) => {
  const { id, project, light } = e.data;
  const t0 = performance.now();
  try {
    const { bytes, stats } = compileProject(project, light);
    parseUntrustedBSP(bytes.buffer);
    postMessage({ id, bytes: bytes.buffer, stats, ms: performance.now() - t0 }, [bytes.buffer]);
  } catch (err) {
    postMessage({ id, error: String(err.message || err) });
  }
};
