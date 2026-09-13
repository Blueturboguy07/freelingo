#!/usr/bin/env python3
"""Execute the installed Swift speech-policy methods against controlled OS doubles.

Requires macOS Swift. This proves guard/control flow, not a native app build or
actual speech/network behavior. Native device/CI checks remain required.
"""
import subprocess
import sys
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
package = root / 'apps/mobile/node_modules/expo-speech-recognition'
with tempfile.TemporaryDirectory(prefix='freelingo-speech-policy-') as temporary:
    for name in ('guard', 'permission'):
        subprocess.run([
            sys.executable,
            str(root / 'scripts/native-speech' / f'{name}.py'),
            str(package),
            name,
            temporary,
        ], check=True)
