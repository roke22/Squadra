#!/usr/bin/env bash
# Squadra: prepare this Mac and join it to a Squadra server. The dashboard
# gives you the exact command, with your code:
#
#   curl -fsSL https://your-server/install/macos.sh | bash -s -- https://your-server CODE [options]
#
# It installs what is missing (tmux with Homebrew, Node.js 22, Claude Code),
# then squadra-host, which joins the machine, installs the Squadra plugin, the
# "squadra-host" command and a service that keeps it running.
# Options are passed to squadra-host: --allow-home, --insecure, --no-service.
set -eu

# (All in a function: piped into bash, the whole script is read before anything runs.)
main() {
  SERVER="${1:-}"; CODE="${2:-}"
  if [ -z "$SERVER" ] || [ -z "$CODE" ]; then
    echo "usage: macos.sh <server-url> <code> [--allow-home] [--insecure] [--no-service]" >&2
    exit 2
  fi
  shift 2
  SHA=""
  ARGS=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --sha256) SHA="${2:-}"; shift 2 ;;
      *) ARGS+=("$1"); shift ;;
    esac
  done

  say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

  if [ "$(id -u)" -eq 0 ]; then
    echo "Run this as your own user, not as root." >&2
    exit 1
  fi

  # 1. tmux, with Homebrew
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [ -x "$b" ] && eval "$("$b" shellenv)" && break
  done
  if ! command -v tmux >/dev/null 2>&1; then
    if ! command -v brew >/dev/null 2>&1; then
      echo "tmux is needed, and it is installed with Homebrew. Install Homebrew first (https://brew.sh):" >&2
      echo '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"' >&2
      echo "then run this command again." >&2
      exit 1
    fi
    say "Installing tmux"
    brew install tmux
  fi

  # 2. Node.js 22.13 or later (with nvm, in your home, if missing or older)
  node_ok() { command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; }
  if ! node_ok; then
    say "Installing Node.js 22 (with nvm, in your home folder)"
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] || curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    set +eu; . "$NVM_DIR/nvm.sh"; nvm install 22 && nvm alias default 22; set -eu
    node_ok || { echo "Node.js 22 could not be installed: install Node.js 22.13 or later, then run this command again." >&2; exit 1; }
  fi

  # 3. Claude Code
  export PATH="$HOME/.local/bin:$PATH"
  if ! command -v claude >/dev/null 2>&1; then
    say "Installing Claude Code"
    curl -fsSL https://claude.ai/install.sh | bash
  fi

  # New terminals find the "claude" and "squadra-host" commands in ~/.local/bin.
  for rc in "$HOME/.zshrc" "$HOME/.bash_profile"; do
    if [ "$rc" = "$HOME/.zshrc" ] || [ -f "$rc" ]; then
      touch "$rc"
      grep -q '\.local/bin' "$rc" || printf '\n# Added by the Squadra installer\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$rc"
    fi
  done

  # 4. squadra-host: downloaded into a new private folder, checked, and run.
  say "Joining this Mac to $SERVER"
  DIR="$(mktemp -d)"
  cd "$DIR"
  curl -fsSLo squadra-host.mjs "${SERVER%/}/host/squadra-host.mjs"
  if [ -n "$SHA" ]; then
    echo "$SHA  squadra-host.mjs" | shasum -a 256 -c - >/dev/null || { echo "squadra-host.mjs does not match the dashboard's checksum: stopped." >&2; exit 1; }
  fi
  node squadra-host.mjs enroll "$SERVER" "$CODE" ${ARGS[@]+"${ARGS[@]}"}

  say "Done"
  echo "If you haven't yet: run 'claude' once in a terminal and sign in, so the sessions can start."
}

main "$@"
