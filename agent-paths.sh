require_safe_agent_path() {
  case "$2" in
    ''|*[!-A-Za-z0-9_./\ ]*)
      echo "ERROR: $1 must use only safe path characters: letters, digits, spaces, /, ., _, and -" >&2
      return 1
      ;;
  esac
}
