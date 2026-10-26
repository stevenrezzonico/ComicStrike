// Self-signed ECDSA certificate management for WebTransport.
// Browsers accept a self-signed cert via `serverCertificateHashes` only if it is
// ECDSA and valid for at most 14 days, so we regenerate it before it expires.

const LIFETIME_DAYS = 13;
const RENEW_AFTER_MS = (LIFETIME_DAYS - 1) * 86400e3;

function pemToDer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function generate(dir, hostnames) {
  const san = hostnames
    .map((h) => (/^[\d.]+$|:/.test(h) ? `IP:${h}` : `DNS:${h}`))
    .join(',');
  const cmd = new Deno.Command('openssl', {
    args: [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-nodes', '-keyout', `${dir}/key.pem`, '-out', `${dir}/cert.pem`,
      '-days', String(LIFETIME_DAYS), '-subj', `/CN=${hostnames[0]}`,
      '-addext', `subjectAltName=${san}`,
    ],
    stdout: 'null',
    stderr: 'piped',
  });
  const { code, stderr } = await cmd.output();
  if (code !== 0) throw new Error(`openssl failed: ${new TextDecoder().decode(stderr)}`);
}

// Returns { cert, key, hash } where hash is the SHA-256 of the DER certificate.
export async function ensureCert(dir, hostnames) {
  await Deno.mkdir(dir, { recursive: true });
  let stale = true;
  try {
    const st = await Deno.stat(`${dir}/cert.pem`);
    stale = Date.now() - st.mtime.getTime() > RENEW_AFTER_MS;
  } catch { /* missing */ }
  if (stale) await generate(dir, hostnames);

  const cert = await Deno.readTextFile(`${dir}/cert.pem`);
  const key = await Deno.readTextFile(`${dir}/key.pem`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', pemToDer(cert)));
  return { cert, key, hash };
}
