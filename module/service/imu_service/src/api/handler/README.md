Generated or hand-written API handlers live here.

Run this after adding public IDL files and config routes:

```bash
./tools/generate-interfaces.sh
```

Generated files are written into this module's `src` tree by default. Handlers
should adapt protocol payloads and call `src/service`; business behavior belongs
in service, scheduler, executor, or adapter layers.
