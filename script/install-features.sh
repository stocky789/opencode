#!/usr/bin/env bash
set -euo pipefail

repo_url="${OPENCODE_FEATURES_REPO:-https://git.stockhome.com.au/stocky789/opencode.git}"
branch="${OPENCODE_FEATURES_BRANCH:-features}"
install_root="${OPENCODE_FEATURES_INSTALL_DIR:-$HOME/.opencode-features}"
source_dir="$install_root/source"
bin_dir="${OPENCODE_FEATURES_BIN_DIR:-$HOME/.local/bin}"

info() {
  printf '[opencode features] %s\n' "$1" >&2
}

require_command() {
  if command -v "$1" >/dev/null 2>&1; then
    return 0
  fi
  printf 'Error: %s is required. %s\n' "$1" "$2" >&2
  exit 1
}

find_bun() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi

  for candidate in "${BUN_INSTALL:-$HOME/.bun}/bin/bun" "$HOME/.bun/bin/bun"; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

ensure_bun() {
  if find_bun; then
    return 0
  fi

  require_command curl "Install curl with your system package manager, then rerun this installer."
  info "Installing Bun"
  curl -fsSL https://bun.sh/install | bash >&2
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"

  if ! find_bun; then
    printf 'Error: Bun installed, but bun was not found. Restart the shell and rerun this installer.\n' >&2
    exit 1
  fi
}

require_command git "Install git with your system package manager, then rerun this installer."
bun_bin="$(ensure_bun)"
bun_dir="$(dirname "$bun_bin")"
case ":$PATH:" in
  *":$bun_dir:"*) ;;
  *) export PATH="$bun_dir:$PATH" ;;
esac

mkdir -p "$install_root" "$bin_dir"

if [ -d "$source_dir/.git" ]; then
  info "Updating $branch branch in $source_dir"
  git -C "$source_dir" fetch origin "$branch" --depth 1
  git -C "$source_dir" checkout -B "$branch" "origin/$branch"
else
  if [ -e "$source_dir" ]; then
    printf 'Error: %s already exists but is not a git checkout. Remove it or set OPENCODE_FEATURES_INSTALL_DIR.\n' "$source_dir" >&2
    exit 1
  fi
  info "Cloning $repo_url#$branch"
  git clone --branch "$branch" --depth 1 "$repo_url" "$source_dir"
fi

info "Installing dependencies"
"$bun_bin" install --cwd "$source_dir"

package_dir="$source_dir/packages/opencode"

cat > "$bin_dir/opencode-features" <<EOF
#!/usr/bin/env sh
OPENCODE_LAUNCH_CWD="\$PWD" exec "$bun_bin" run --cwd "$package_dir" --conditions=browser src/index.ts "\$@"
EOF

cat > "$bin_dir/opencode" <<EOF
#!/usr/bin/env sh
OPENCODE_LAUNCH_CWD="\$PWD" exec "$bun_bin" run --cwd "$package_dir" --conditions=browser src/index.ts "\$@"
EOF

chmod 755 "$bin_dir/opencode-features" "$bin_dir/opencode"

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *)
    shell_name="$(basename "${SHELL:-sh}")"
    case "$shell_name" in
      zsh) profile="$HOME/.zshrc" ;;
      fish) profile="$HOME/.config/fish/config.fish" ;;
      *) profile="$HOME/.profile" ;;
    esac

    if [ "$shell_name" = "fish" ]; then
      mkdir -p "$(dirname "$profile")"
      if ! grep -Fq "fish_add_path $bin_dir" "$profile" 2>/dev/null; then
        printf '\n# opencode features\nfish_add_path %s\n' "$bin_dir" >> "$profile"
      fi
    else
      if ! grep -Fq "export PATH=$bin_dir:\$PATH" "$profile" 2>/dev/null; then
        printf '\n# opencode features\nexport PATH=%s:$PATH\n' "$bin_dir" >> "$profile"
      fi
    fi
    export PATH="$bin_dir:$PATH"
    info "Added $bin_dir to PATH in $profile. Open a new terminal after this install."
    ;;
esac

info "Installed feature branch launcher"
printf '\nRun:\n  opencode\n\nOr explicitly:\n  opencode-features\n'
