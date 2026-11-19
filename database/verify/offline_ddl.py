"""Isolated local PostgreSQL single-user SQL smoke check when TCP is denied.

Usage: python database/verify/offline_ddl.py POSTGRES_EXE DATA_DIRECTORY
Only run against a disposable initdb cluster with no postmaster running. This
does not replace psql migration ledger or independent-connection verification.
"""

import pathlib
import re
import subprocess
import sys

postgres, cluster = sys.argv[1:3]
root = pathlib.Path(__file__).resolve().parents[1]
files = sorted((root / "migrations").glob("*.sql"))
if "--only-verify" in sys.argv[3:]:
    files = [root / "verify" / "integrity.sql"]
if "--verify" in sys.argv[3:]:
    files.append(root / "verify" / "integrity.sql")
for file in files:
    sql = re.sub(r"(?m)^\s*--[^\r\n]*", "", file.read_text(encoding="utf-8"))
    sql = re.sub(r"\r?\n", " ", sql)
    result = subprocess.run(
        [postgres, "--single", "-D", cluster, "postgres"],
        input=sql + "\n", text=True, capture_output=True, check=False,
    )
    errors = [line for line in result.stderr.splitlines() if "ERROR:" in line or "FATAL:" in line]
    print(f"{file.name}: exit={result.returncode}, postgres_errors={len(errors)}")
    for line in errors:
        print(line)
    if result.returncode != 0 or errors:
        sys.exit(1)
