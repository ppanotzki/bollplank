#!/usr/bin/env bash
# Installs Bollplank from this folder: checks git and Node 20 or later, links bin/bollplank into
# ~/.local/bin, says how to put that folder on PATH when it is not, and runs `bollplank init`.
# It never replaces a file or a link that is not its own. Running it again is safe.
#
#   ./install.sh            install, then run bollplank init
#   ./install.sh --no-init  install only
set -euo pipefail

run_init=1
for arg in "$@"; do
  case "$arg" in
    --no-init) run_init=0 ;;
    -h|--help)
      echo "usage: install.sh [--no-init]"
      exit 0
      ;;
    *)
      echo "Unknown option $arg. Usage: install.sh [--no-init]" >&2
      exit 2
      ;;
  esac
done

if ! command -v git >/dev/null 2>&1; then
  echo "Bollplank needs git. Install it (on a Mac: xcode-select --install), then run this script again." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Bollplank needs Node 20 or later. Install it from https://nodejs.org, then run this script again." >&2
  exit 1
fi
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 20 ]; then
  echo "Bollplank needs Node 20 or later, and this is Node $(node --version). Install a newer one from https://nodejs.org, then run this script again." >&2
  exit 1
fi

kit="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
recommended="$HOME/.bollplank/kit"
recommended_real="$(cd "$recommended" 2>/dev/null && pwd -P || echo "$recommended")"
if [ "$kit" != "$recommended_real" ]; then
  echo "The kit is at $kit. The recommended place is ~/.bollplank/kit, which the guides assume. It works from here too."
fi

bin_dir="$HOME/.local/bin"
link="$bin_dir/bollplank"
target="$kit/bin/bollplank"
mkdir -p "$bin_dir"

# The absolute, resolved form of where a link points.
resolved() {
  local to
  to="$(readlink "$1")"
  case "$to" in
    /*) ;;
    *) to="$(dirname "$1")/$to" ;;
  esac
  echo "$(cd "$(dirname "$to")" 2>/dev/null && pwd -P || dirname "$to")/$(basename "$to")"
}

if [ -L "$link" ]; then
  current="$(resolved "$link")"
  if [ "$current" = "$target" ]; then
    echo "$link already links to this kit."
  else
    echo "$link already links to $current, which is not this kit. Bollplank left it alone. Remove it or point it at $target, then run this script again." >&2
    exit 1
  fi
elif [ -e "$link" ]; then
  echo "$link already exists and is not a link. Bollplank left it alone. Move it away, then run this script again." >&2
  exit 1
else
  ln -s "$target" "$link"
  echo "Linked $link to $target."
fi
node "$kit/lib/setup/links.mjs" record-bin "$link"

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *)
    case "$(basename "${SHELL:-}")" in
      bash) profile="~/.bashrc" ;;
      *) profile="~/.zshrc" ;;
    esac
    echo
    echo "$bin_dir is not on your PATH. Add this line to $profile, then open a new terminal:"
    echo
    echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    echo
    ;;
esac

if [ "$run_init" = 1 ]; then
  exec "$target" init
fi
echo "Installed. Run bollplank init to set it up."
