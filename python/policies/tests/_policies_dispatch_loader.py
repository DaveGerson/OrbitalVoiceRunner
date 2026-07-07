"""Loads ../dispatch.py under a directory-unique sys.modules key.

Needed only when pytest collects python/policies/tests together with python/synthesizer/tests
in ONE process: both directories have their own dispatch.py, and a bare `import dispatch` in
both would alias whichever loaded first (bead wsm-e2e-pinned-f2om). Production code is
unaffected: policies/__main__.py and synthesizer/__main__.py always run as separate
subprocesses, so they never share a sys.modules table.
"""
import importlib.util
import os

_PATH = os.path.join(os.path.dirname(__file__), "..", "dispatch.py")


def load_dispatch():
    spec = importlib.util.spec_from_file_location("policies_dispatch_module", _PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
