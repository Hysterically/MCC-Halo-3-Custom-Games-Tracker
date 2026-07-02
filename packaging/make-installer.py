"""Build the one-file friends installer: installer-template.bat + friends.env
-> h3-tracker.bat (the #tracker-download attachment).

The .env lines are embedded as ::ENV:: comment lines at the bottom of the bat
(never executed; extracted to app\\.env by the bat itself). The OUTPUT CONTAINS
SECRETS - write it outside the repo and never commit it.

Usage: python packaging/make-installer.py <output-path>
"""

import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
out = Path(sys.argv[1])

template = (root / "packaging" / "installer-template.bat").read_text(encoding="ascii")
env_lines = (root / "friends.env").read_text(encoding="ascii").splitlines()

bat = template.rstrip("\r\n") + "\r\n"
for line in env_lines:
    bat += f"::ENV::{line}\r\n"

# Batch files want CRLF; write bytes so no newline translation happens.
out.write_bytes(bat.replace("\r\n", "\n").replace("\n", "\r\n").encode("ascii"))
print(f"wrote {out} ({out.stat().st_size} bytes)")
