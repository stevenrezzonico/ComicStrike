// Worker for tools/gen_texturedata.js: analyzes the textures it is sent.
import { analyze } from './texanalysis.js';
import { encodeRecord } from '../client/texcolors.js';

self.onmessage = (e) => {
  self.postMessage(e.data.map((t) => {
    const a = analyze(t);
    return a ? encodeRecord(a) : null;
  }));
};
