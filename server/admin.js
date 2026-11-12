// The admin page's HTTP side (client/admin.html) for a room, `?room=<code>`: GET /admin/state
// answers its state as JSON (Host.adminState), GET /admin/catalog the console's names with
// their help, limits and defaults (Console.catalog: the page's forms), POST /admin/exec runs
// the body as one rcon line and answers { output }.
//
// Each request carries the rcon password in the `x-rcon-password` header, checked and
// counted like rcon's (Host.rconRefusal: 5 bad guesses an address, 60 a minute in all). A
// custom header needs a CORS preflight, which this server never answers (an OPTIONS gets a
// 405), so no other site's page can send these requests from its visitors' browsers. Over
// plain HTTP too: a room's password came back over the same kind of connection when the room
// was made, and it reaches that room alone.

export const ADMIN_BODY = 4096; // bytes of an exec's command line at most

const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

// The request body as text, refused past `max` bytes (whatever content-length says).
async function readText(req, max) {
  if (Number(req.headers.get('content-length') || 0) > max) return null;
  const parts = [];
  let size = 0;
  if (req.body) {
    for await (const part of req.body) {
      size += part.byteLength;
      if (size > max) return null;
      parts.push(part);
    }
  }
  const all = new Uint8Array(size);
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

// The answer to a request under /admin/. address: the caller's IP; hostFor(room code) ->
// the room's Host, or null (no such room).
export async function adminResponse(req, url, { address, hostFor }) {
  const op = url.pathname.slice('/admin/'.length);
  if (op !== 'state' && op !== 'catalog' && op !== 'exec') return json({ error: 'not found' }, 404);
  if (req.method !== (op === 'exec' ? 'POST' : 'GET')) return json({ error: 'method not allowed' }, 405);
  const host = hostFor((url.searchParams.get('room') || '').toLowerCase());
  if (!host) return json({ error: 'no such room: it may have closed' }, 404);
  let password = req.headers.get('x-rcon-password');
  if (password === null) return json({ error: 'the rcon password is needed' }, 401);
  try { // URI-encoded: a header holds only Latin-1 (curl: encode a `%` in it as %25)
    password = decodeURIComponent(password);
  } catch {
    // not encoded: as it is
  }
  const refused = host.rconRefusal(address, password, 'the admin page') // (it adds the address);
  if (refused !== '') return json({ error: refused ?? 'Bad rcon_password.' }, 403);
  if (op === 'state') return json(host.adminState());
  if (op === 'catalog') return json(host.con.catalog());
  const command = await readText(req, ADMIN_BODY);
  if (command === null) return json({ error: `the command is too long (${ADMIN_BODY} bytes at most)` }, 413);
  console.log(`rcon from the admin page (${address}): ${host.redacted(command)}`);
  return json({ output: host.capture(command) });
}
