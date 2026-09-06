wk() {
  local root="${WORKSPACES_ROOT:-$HOME/workspaces}"
  local editor="${WK_EDITOR:-code}"
  if [ -z "$1" ]; then
    local file found=0
    for file in "$root"/*.code-workspace; do
      [ -f "$file" ] || continue
      found=1
      printf '  %s\n' "$(basename "$file" .code-workspace)"
    done
    [ "$found" = 1 ] || echo "no workspaces in $root"
    return 0
  fi
  local file="$root/$1.code-workspace"
  if [ ! -f "$file" ]; then
    echo "workspace '$1' not found in $root"
    return 1
  fi
  "$editor" "$file" >/dev/null 2>&1 &
}
