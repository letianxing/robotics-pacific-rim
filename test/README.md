# Stability Tests

Offline stability tests for framework scripts, ROS2 Docker profile selection,
vision stack contracts, scaffold defaults, and documentation examples.

Run:

```bash
./pr test:stability
```

These tests avoid real Docker builds, registry access, apt installs, and SSH.
Remote deploy coverage uses `--dry-run`.
