#!/bin/sh
# Brings /opt/comicstrike up to date with the GitHub repository and restarts the game when
# a new commit has arrived (deploy/comicstrike-update.timer runs this every minute, so the
# server follows main by itself; the maps are git-ignored and stay). Installed as
# /usr/local/bin/comicstrike-update: it rewrites the checkout, so it cannot live in it. Prints nothing when
# there is nothing to do, so the journal only shows the deployments.
set -e
cd /opt/comicstrike
git fetch -q origin main
local=$(git rev-parse HEAD)
remote=$(git rev-parse origin/main)
[ "$local" = "$remote" ] && exit 0
git reset -q --hard origin/main
echo "deployed $(git log --oneline -1)"
systemctl restart comicstrike
