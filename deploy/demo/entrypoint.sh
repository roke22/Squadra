#!/bin/sh
# Runs as root only to pick the user: the owner of the folder mounted at
# /squadra (who created it on the computer), so the files stay theirs. A
# folder Docker created by itself (root's) is given to the image's "node" user.
# Its home folder is /squadra/home: Squadra reads the home from the user's
# account, not from $HOME, and everything must stay in the mounted folder.
set -eu
D="${SQUADRA_DIR:-/squadra}"
mkdir -p "$D"
if [ "$(id -u)" != 0 ]; then exec start.sh; fi # (started with --user: as is)
uid=$(stat -c %u "$D")
gid=$(stat -c %g "$D")
if [ "$uid" = 0 ]; then
  chown node:node "$D"
  uid=$(id -u node)
  gid=$(id -g node)
else
  [ "$(id -g node)" = "$gid" ] || groupmod -o -g "$gid" node
  [ "$(id -u node)" = "$uid" ] || usermod -o -u "$uid" node
fi
usermod -d "$D/home" node
exec setpriv --reuid="$uid" --regid="$gid" --init-groups env HOME="$D/home" USER=node start.sh
