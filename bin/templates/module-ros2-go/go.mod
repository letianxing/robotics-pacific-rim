module github.com/pacific-rim/pacific-rim/module/service/{{name}}

go 1.25.0

require (
	github.com/pacific-rim/pacific-rim/infra v0.0.0
	github.com/pacific-rim/pacific-rim/pkg/idl v0.0.0
	github.com/tiiuae/rclgo v0.0.0-20260225085354-508dd42245da
)

require (
	github.com/alessio/shellescape v1.4.2 // indirect
	github.com/fsnotify/fsnotify v1.6.0 // indirect
	github.com/hashicorp/hcl v1.0.0 // indirect
	github.com/inconshreveable/mousetrap v1.1.0 // indirect
	github.com/kivilahtio/go-re v0.1.8 // indirect
	github.com/klauspost/compress v1.18.5 // indirect
	github.com/magiconair/properties v1.8.7 // indirect
	github.com/mitchellh/go-homedir v1.1.0 // indirect
	github.com/mitchellh/mapstructure v1.5.0 // indirect
	github.com/nats-io/nats.go v1.52.0 // indirect
	github.com/nats-io/nkeys v0.4.15 // indirect
	github.com/nats-io/nuid v1.0.1 // indirect
	github.com/pelletier/go-toml/v2 v2.0.8 // indirect
	github.com/spf13/afero v1.9.5 // indirect
	github.com/spf13/cast v1.5.1 // indirect
	github.com/spf13/cobra v1.7.0 // indirect
	github.com/spf13/jwalterweatherman v1.1.0 // indirect
	github.com/spf13/pflag v1.0.5 // indirect
	github.com/spf13/viper v1.16.0 // indirect
	github.com/subosito/gotenv v1.4.2 // indirect
	golang.org/x/crypto v0.49.0 // indirect
	golang.org/x/exp v0.0.0-20230811145659-89c5cff77bcb // indirect
	golang.org/x/mod v0.33.0 // indirect
	golang.org/x/sync v0.20.0 // indirect
	golang.org/x/sys v0.42.0 // indirect
	golang.org/x/text v0.35.0 // indirect
	golang.org/x/tools v0.42.0 // indirect
	gopkg.in/ini.v1 v1.67.0 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
)

replace github.com/pacific-rim/pacific-rim/infra => ../../../infra
replace github.com/pacific-rim/pacific-rim/pkg/idl => ../../../pkg/idl
