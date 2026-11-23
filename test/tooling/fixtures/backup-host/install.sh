#!/usr/bin/env bash
# Stub of install for test/tooling/backup-host.test.ts: copies with the mode asked for (a test does not run as root, so the owner is
# recorded, not set). STUB_INSTALL_EXIT makes it fail.
set -u
echo "install $*" >> "$STUB_DIR/calls.log"
[ "${STUB_INSTALL_EXIT:-0}" = 0 ] || exit "$STUB_INSTALL_EXIT"
mode=0755
while [ $# -gt 2 ]; do
  case $1 in
    -m)
      mode=$2
      shift 2
      ;;
    -o | -g) shift 2 ;;
    *) shift ;;
  esac
done
cp "$1" "$2" && chmod "$mode" "$2"
