"""One bounded verification entry point; no real model or catalog requests."""
import argparse
import json
import os
import socket
import subprocess
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_workbench
import test_transport


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    original_connect, original_strftime = socket.create_connection, time.strftime
    external = []
    def local_connection(address, *values, **kwargs):
        if address[0] not in ('127.0.0.1', 'localhost', '::1'):
            external.append(address[0]); raise AssertionError('external network forbidden')
        return original_connect(address, *values, **kwargs)
    def fixed_time(fmt, *_):
        return original_strftime(fmt, time.struct_time((2026, 11, 4, 13, 0, 0, 2, 308, -1)))
    suite = unittest.TestSuite([unittest.defaultTestLoader.loadTestsFromModule(test_workbench), unittest.defaultTestLoader.loadTestsFromModule(test_transport)])
    with patch.object(socket, 'create_connection', local_connection), patch.object(time, 'strftime', fixed_time):
        result = unittest.TextTestRunner(verbosity=2).run(suite)
    node = subprocess.run(['node', str(ROOT / 'tests/core/workbuddy.test.cjs')], capture_output=True, encoding='utf-8', timeout=20)
    sdk = json.loads(node.stdout) if node.returncode == 0 else {'ok': False, 'error': node.stderr[-3000:]}
    data = {'ok': result.wasSuccessful() and node.returncode == 0, 'tests_run': result.testsRun,
        'failures': len(result.failures), 'errors': len(result.errors), 'external_model_calls': 0,
        'external_catalog_calls': 0, 'blocked_external_network_attempts': external,
        'boundaries': {**test_workbench.EVIDENCE, **test_transport.EVIDENCE}, 'sdk': sdk}
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(data, ensure_ascii=False, indent=2))
    return 0 if data['ok'] else 1


if __name__ == '__main__': raise SystemExit(main())
