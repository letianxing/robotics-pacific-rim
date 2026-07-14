# Robot Profiles

Robot profiles describe deployable or planned module combinations for a robot
class. They connect service modules to `pkg/robot/capabilities.json` without
embedding module business logic or IDL source definitions.

Profile status:

- `active`: can be checked and used by `./pr robot:deploy`.
- `template`: documents a recommended stack for a robot class; missing services
  are allowed until those modules are created through the normal scaffold.

Useful commands:

```sh
./pr robot:profiles
./pr robot:show pure-driver-sample
./pr robot:check
./pr robot:deploy pure-driver-sample --dry-run --host 192.168.1.20 --domain-id 42
```
