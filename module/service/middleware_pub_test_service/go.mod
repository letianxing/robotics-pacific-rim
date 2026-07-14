module github.com/pacific-rim/pacific-rim/module/service/middleware_pub_test_service

go 1.25.0

require (
	github.com/pacific-rim/pacific-rim/infra v0.0.0
	github.com/pacific-rim/pacific-rim/pkg/idl v0.0.0
)

require (
	github.com/klauspost/compress v1.18.5 // indirect
	github.com/kr/pretty v0.3.1 // indirect
	github.com/nats-io/nats.go v1.52.0 // indirect
	github.com/nats-io/nkeys v0.4.15 // indirect
	github.com/nats-io/nuid v1.0.1 // indirect
	github.com/tiiuae/rclgo v0.0.0-20260225085354-508dd42245da // indirect
	golang.org/x/crypto v0.50.0 // indirect
	golang.org/x/net v0.52.0 // indirect
	golang.org/x/sys v0.46.0 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
)

replace github.com/pacific-rim/pacific-rim/infra => ../../../infra

replace github.com/pacific-rim/pacific-rim/pkg/idl => ../../../pkg/idl
