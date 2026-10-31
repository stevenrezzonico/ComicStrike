// The map editor's compile worker: a project in, the BSP file out (shared/bspwriter.js
// through project.js), checked like any map from outside (parseUntrustedBSP), so what the
// editor exports or plays is a map the game takes; and a .bsp opened in the editor, checked
// the same way and turned back into a project (decompile.js).
//
// In:  { id, project, light: 'full' | 'draft' } | { id, open: ArrayBuffer (transferred), name }
// Out: { id, bytes (transferred), stats, ms } | { id, project, report, ms } | { id, error }

import { compileProject } from './project.js';
import { decompileBSP } from './decompile.js';
import { parseUntrustedBSP } from '../../shared/bsp.js';

onmessage = (e) => {
  const { id, project, light, open, name } = e.data;
  const t0 = performance.now();
  try {
    if (open) {
      const r = decompileBSP(parseUntrustedBSP(open), name);
      postMessage({ id, project: r.project, report: r.report, ms: performance.now() - t0 });
      return;
    }
    const { bytes, stats } = compileProject(project, light);
    parseUntrustedBSP(bytes.buffer);
    postMessage({ id, bytes: bytes.buffer, stats, ms: performance.now() - t0 }, [bytes.buffer]);
  } catch (err) {
    postMessage({ id, error: String(err.message || err) });
  }
};
