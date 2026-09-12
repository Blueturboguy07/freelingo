"""Put `tools/soundbank/` on `sys.path` so the tests can import `synthesize`.

`tools/soundbank/pyproject.toml` already declares `pythonpath = ["."]`, but pytest only
reads that when *it* is the rootdir config — and the documented invocation runs from the
repository root, where pytest picks the root as its rootdir and the setting never applies.
The symptom is `ModuleNotFoundError: No module named 'synthesize'`, which reads like a
missing dependency and is really a missing path.

Four lines here make the import work from any working directory, which is what a test
ought to be able to assume.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
