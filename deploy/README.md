# Deploying ComicStrike on a dedicated server

How to run ComicStrike at `https://cstrike.click/` on a Linux server: Debian 12, Ubuntu 22.04 or newer, or DietPi on Bookworm. The server uses a Let's Encrypt certificate and port 443.

- **TCP 443:** serves the game's pages over HTTPS.
- **UDP 443:** carries the game itself (WebTransport over QUIC). Both use the same certificate.
- **TCP 80:** redirects `http://` to the HTTPS site. Let's Encrypt also uses it while renewing.

With a real certificate, the browser checks it like any other site's. The pinned self-signed certificate that `deno task start` makes is only for development.

## 1. DNS and firewall

1. Add an `A` record: `cstrike.click` → the server's IPv4 address.
   - Leave out `AAAA` unless you set `BIND=::` and have tested IPv6.
2. Open these ports, on the server and on any provider firewall or router in front of it:

   ```bash
   sudo ufw allow 80/tcp
   sudo ufw allow 443/tcp
   sudo ufw allow 443/udp
   ```

   UDP 443 is the easy one to forget. Without it the page loads but the game never connects. A hosting provider's own firewall in front of the VPS (Infomaniak's Public Cloud panel, for one) must open the same three ports.

   To serve `www.cstrike.click` too, give it an `A` record as well, add it to the certbot command (`-d www.cstrike.click`) and to `HOSTNAMES`.

## 2. Deno and the files

Deno 2.9 or newer:

```bash
curl -fsSL https://deno.land/install.sh | sh
sudo install -m 755 ~/.deno/bin/deno /usr/local/bin/deno
```

The service user and its folder:

```bash
sudo useradd --system --home /opt/comicstrike --shell /usr/sbin/nologin comicstrike
sudo mkdir -p /opt/comicstrike /etc/comicstrike
```

From the development machine, copy the committed code. Then copy the maps separately: the repository only tracks `maps/de_playground.bsp`.

```bash
git archive --format=tar.gz -o comicstrike.tar.gz HEAD
scp comicstrike.tar.gz you@cstrike.click:/tmp/
scp maps/*.bsp you@cstrike.click:/tmp/maps/
```

On the server:

```bash
sudo tar -xzf /tmp/comicstrike.tar.gz -C /opt/comicstrike
sudo mkdir -p /opt/comicstrike/maps && sudo cp /tmp/maps/*.bsp /opt/comicstrike/maps/
sudo chown -R root:root /opt/comicstrike   # the server only reads it
```

## 3. The certificate

Get the first certificate before the server runs, while port 80 is still free. The two hooks are saved for renewals:

- Before a renewal, the server stops so Let's Encrypt can use port 80.
- After it, the server starts again with the new certificate.

```bash
sudo apt install certbot
sudo certbot certonly --standalone -d cstrike.click \
  --pre-hook "systemctl stop comicstrike" --post-hook "systemctl start comicstrike"
```

Certbot's timer renews the certificate about every 60 days. That takes the game offline for a few seconds and drops whoever is playing.

## 4. Settings and the service

```bash
sudo cp /opt/comicstrike/deploy/comicstrike.env.example /etc/comicstrike/comicstrike.env
sudo chmod 600 /etc/comicstrike/comicstrike.env
sudo nano /etc/comicstrike/comicstrike.env          # set RCON_PASSWORD (and MAP)
sudo cp /opt/comicstrike/deploy/comicstrike.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now comicstrike
```

To use a different domain, change it in `comicstrike.service` (two `LoadCredential` lines) and in `comicstrike.env` (`HOSTNAMES`).

## 5. Check it

```bash
systemctl status comicstrike
journalctl -u comicstrike -f        # the server's log (joins, rounds, errors)
curl -I http://cstrike.click/          # 301 to https://
curl -s https://cstrike.click/connect.json   # "certHash":null and the server info
```

Then open `https://cstrike.click/` in Chrome or Edge and click Play.

| Symptom | Likely cause |
|---|---|
| The page loads, but Play times out | UDP 443 is blocked somewhere. |
| `curl` fails on 443 | Read the journal: the certificate paths or the port permissions. |

## Running it

- **Console:** the server has no terminal under systemd. Use rcon from the game console (`rcon_password <password>`, then `rcon status`, `rcon map de_inferno`, `rcon mp_restartgame 1`). Startup settings go in `/opt/comicstrike/cfg/server.cfg` and `cfg/gamemode_<mode>_server.cfg`.
- **Updating:** the server follows the repository's `main` by itself: `/opt/comicstrike` is a `git clone` of it, and `comicstrike-update.timer` runs `deploy/update.sh` every minute, which fetches, resets to `origin/main` when a new commit is there and restarts the game (dropping whoever is playing, so commit with that in mind). `journalctl -u comicstrike-update` lists the deployments. To set it up on a fresh server, clone instead of unpacking an archive in step 2 (`sudo git clone https://github.com/stevenrezzonico/ComicStrike.git /opt/comicstrike`, then copy the maps in), and:

  ```bash
  sudo git config --global --add safe.directory /opt/comicstrike
  sudo cp /opt/comicstrike/deploy/comicstrike-update.{service,timer} /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now comicstrike-update.timer
  ```

  (A push-triggered GitHub Actions deploy would need an SSH key stored as a repository secret; polling a public repository needs none.)
- **Hosting control panels (Pterodactyl and similar):** run the same `deno run --unstable-net --allow-net --allow-read --allow-env server/main.js`. Set the variables from `comicstrike.env`, plus `TLS_CERT` and `TLS_KEY` pointing at the certificate files, and give the server TCP and UDP 443.
