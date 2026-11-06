#!/usr/bin/env bash
# Squadra: prepare this machine (Linux, or Ubuntu on WSL) and join it to a
# Squadra server. The dashboard gives you the exact command, with your code. It
# downloads this script, checks it, and leaves the code in a file for it:
#
#   bash install.sh https://your-server --code-file code [options]
#
# It installs what is missing (tmux, Node.js 22, Claude Code), then
# squadra-host, which joins the machine, installs the Squadra plugin, the
# "squadra-host" command and a service that keeps it running.
# Options are passed to squadra-host: --allow-home, --insecure, --no-service.
# --allow-root: install and run it as root (sessions then have full control
# of this machine, to change the operating system).
set -eu

SELF="$0"

# (All in a function: piped into bash, the whole script is read before anything runs.)
main() {
  SERVER="${1:-}"; [ $# -gt 0 ] && shift
  # The code comes in a file, so it is in no program's arguments, which anyone
  # on this machine can read (or after the URL, as older commands gave it).
  CODE=""; CODE_FILE=""
  case "${1:-}" in ""|-*) ;; *) CODE="$1"; shift ;; esac
  SHA=""
  ROOT_OK=""
  OS_USER=""
  ARGS=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --sha256) [ $# -ge 2 ] || { echo "--sha256 needs a value" >&2; exit 2; }; SHA="$2"; shift 2 ;;
      --code-file) [ $# -ge 2 ] || { echo "--code-file needs a path" >&2; exit 2; }; CODE_FILE="$2"; shift 2 ;;
      --server-key) ARGS+=("--server-key=${2:-}"); shift 2 ;; # (from windows.bat: no "=" there)
      --company) ARGS+=("--company=${2:-}"); shift 2 ;;
      --os-user) [ $# -ge 2 ] || { echo "--os-user needs a name" >&2; exit 2; }; OS_USER="$2"; shift 2 ;;
      --os-user=*) OS_USER="${1#--os-user=}"; [ -n "$OS_USER" ] || { echo "--os-user needs a name" >&2; exit 2; }; shift ;;
      --allow-root) ROOT_OK=1; shift ;;
      *) ARGS+=("$1"); shift ;;
    esac
  done
  if [ -n "$CODE_FILE" ]; then
    [ -f "$CODE_FILE" ] || { echo "--code-file: $CODE_FILE is not there" >&2; exit 2; }
    CODE="$(cat "$CODE_FILE")"
    rm -f "$CODE_FILE"
  fi
  if [ -z "$SERVER" ] || [ -z "$CODE" ]; then
    echo "usage: linux.sh <server-url> --code-file <file> [--allow-home] [--insecure] [--no-service] [--company <id>] [--os-user <name>]" >&2
    exit 2
  fi

  say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
  as_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi }
  install_pkg() {
    if command -v apt-get >/dev/null 2>&1; then { as_root apt-get update -qq || true; } && as_root apt-get install -y "$@"
    elif command -v dnf >/dev/null 2>&1; then as_root dnf install -y "$@"
    elif command -v pacman >/dev/null 2>&1; then as_root pacman -S --needed --noconfirm "$@"
    elif command -v zypper >/dev/null 2>&1; then as_root zypper install -y "$@"
    else echo "Install $* with your package manager, then run this command again." >&2; exit 1
    fi
  }

  # Another system user for this company's sessions, created if needed: what
  # really keeps companies apart on one machine. The rest runs again as that user.
  if [ -n "$OS_USER" ]; then
    case "$OS_USER" in
      ""|root|*[!a-z0-9_-]*|[!a-z_]*) echo "--os-user: \"$OS_USER\" is not a name for a new user (lowercase letters, digits, - and _)" >&2; exit 2 ;;
    esac
    [ "$(id -u)" -eq 0 ] || { echo "--os-user needs root: run this with sudo." >&2; exit 1; }
    if ! id "$OS_USER" >/dev/null 2>&1; then
      say "Creating the system user $OS_USER"
      useradd -m -s /bin/bash "$OS_USER"
      # (Many systems leave a new home readable by everyone: that isn't apart.)
      chmod 700 "$(getent passwd "$OS_USER" | cut -d: -f6)"
    elif [ "$(id -u "$OS_USER")" -lt 1000 ]; then
      # (A system account: its sessions would have whatever rights it has.)
      echo "--os-user: $OS_USER is an account of the system, not a person's or a company's: choose another name." >&2
      exit 2
    fi
    if ! command -v tmux >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then install_pkg tmux curl; fi
    # (So its service keeps running without anyone logged in as it.)
    loginctl enable-linger "$OS_USER" 2>/dev/null || true
    AS_USER_ENV=("HOME=$(getent passwd "$OS_USER" | cut -d: -f6)" "XDG_RUNTIME_DIR=/run/user/$(id -u "$OS_USER")" "PATH=$PATH")
    SWITCH=(runuser -u "$OS_USER" --)
    command -v runuser >/dev/null 2>&1 || SWITCH=(sudo -H -u "$OS_USER")
    # This same script, already checked, and the code, in a folder of that user.
    WORK="$(mktemp -d)"
    if [ -f "$SELF" ] && [ "${BASH_SOURCE[0]:-}" = "$SELF" ]; then cp "$SELF" "$WORK/install.sh"
    else curl -fsSLo "$WORK/install.sh" "${SERVER%/}/install/linux.sh" # (Piped in, as older commands did: there is no file to copy.)
    fi
    printf %s "$CODE" > "$WORK/code"
    chown -R "$OS_USER" "$WORK"
    RC=0
    ( cd "$WORK" && "${SWITCH[@]}" env "${AS_USER_ENV[@]}" bash install.sh "$SERVER" --code-file code ${SHA:+--sha256 "$SHA"} ${ARGS[@]+"${ARGS[@]}"} ) || RC=$?
    rm -rf "$WORK"
    exit $RC
  fi

  if [ "$(id -u)" -eq 0 ] && [ -z "$ROOT_OK" ]; then
    echo "This is root: sessions run as the user who installs them, so they would have full control of this machine." >&2
    echo "Run it as your own user, or add --allow-root to the command if that is what you want (to let Claude change the system)." >&2
    exit 1
  fi
  if [ "$(id -u)" -eq 0 ]; then
    say "Installing as root: sessions will have full control of this machine"
  fi

  # 1. tmux (and curl, for what follows)
  if ! command -v tmux >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
    say "Installing tmux (it may ask for your password)"
    install_pkg tmux curl
  fi

  # 2. Node.js 22.13 or later (with nvm, in your home, if missing or older)
  # (On WSL, what Windows installed isn't usable here: /mnt/c/…)
  native() {
    p="$(command -v "$1" 2>/dev/null)" || return 1
    case "$(uname -r)" in *[Mm]icrosoft*) case "$p" in /mnt/*) return 1 ;; esac ;; esac
  }
  node_ok() { native node && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; }
  if ! node_ok; then
    say "Installing Node.js 22 (with nvm, in your home folder)"
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] || curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    set +eu; . "$NVM_DIR/nvm.sh"; nvm install 22 && nvm alias default 22; set -eu
    node_ok || { echo "Node.js 22 could not be installed: install Node.js 22.13 or later, then run this command again." >&2; exit 1; }
  fi

  # 3. Claude Code
  export PATH="$HOME/.local/bin:$PATH"
  if ! native claude; then
    say "Installing Claude Code"
    curl -fsSL https://claude.ai/install.sh | bash
  fi

  # New terminals find the "claude" and "squadra-host" commands in ~/.local/bin.
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [ -f "$rc" ] && ! grep -q '\.local/bin' "$rc"; then
      # (Managed elsewhere and read-only, as with home-manager: not worth stopping for.)
      { printf '\n# Added by the Squadra installer\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$rc"; } 2>/dev/null || echo "Could not add ~/.local/bin to $rc: add it to your PATH yourself." >&2
    fi
  done

  # 4. squadra-host: downloaded into a new private folder, checked, and run.
  say "Joining this machine to $SERVER"
  DIR="$(mktemp -d)"
  cd "$DIR"
  curl -fsSLo squadra-host.mjs "${SERVER%/}/host/squadra-host.mjs"
  if [ -n "$SHA" ]; then
    echo "$SHA  squadra-host.mjs" | sha256sum -c - >/dev/null || { echo "squadra-host.mjs does not match the dashboard's checksum: stopped." >&2; exit 1; }
  fi
  printf %s "$CODE" > code
  node squadra-host.mjs enroll "$SERVER" --code-file=code ${ARGS[@]+"${ARGS[@]}"}

  say "Done"
  case " ${ARGS[*]-} " in
    *" --company="*) ;; # (It has said how: this company has its own login.)
    *) echo "If you haven't yet: run 'claude' once in a terminal and sign in, so the sessions can start." ;;
  esac
}

main "$@"
