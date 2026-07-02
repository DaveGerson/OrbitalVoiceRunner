"""Entry point the TS client spawns: `python -X utf8 -u <dir>/policies/__main__.py`.
Bootstraps the policies dir onto sys.path so `import dispatch` resolves whether launched
as a file path (sys.path[0] = this dir) or via `-m`, then runs the daemon loop.

Byte-level mirror of python/synthesizer/__main__.py — see that file's docstring.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dispatch import main  # noqa: E402

if __name__ == "__main__":
    main()
