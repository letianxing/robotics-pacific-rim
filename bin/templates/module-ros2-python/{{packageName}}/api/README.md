API handlers live here.

After adding public IDL files and config routes, inspect the generated manifest:

```bash
node bin/generate-interface-scaffold.mjs module/service/{{name}} --dry-run
```

The scaffold writes templates for provider-side service handlers and publisher
helpers. Subscriber routes and downstream service calls remain manifest/runtime
configuration and should be handled explicitly in business code.
