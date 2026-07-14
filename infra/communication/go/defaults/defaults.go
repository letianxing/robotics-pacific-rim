package defaults

import (
	communication "github.com/pacific-rim/pacific-rim/infra/communication/go/contracts"
	"github.com/pacific-rim/pacific-rim/infra/communication/go/core"
	commdds "github.com/pacific-rim/pacific-rim/infra/communication/go/dds"
	commfastdds "github.com/pacific-rim/pacific-rim/infra/communication/go/fastdds"
	commnats "github.com/pacific-rim/pacific-rim/infra/communication/go/nats"
	commros2 "github.com/pacific-rim/pacific-rim/infra/communication/go/ros2"
)

func RegisterDefaultBackends() {
	if !core.IsRegistered(communication.TransportNATS) {
		commnats.RegisterNativeBus()
	}
	if !core.IsRegistered(communication.TransportCycloneDDS) {
		commdds.RegisterNativeBus()
	}
	if !core.IsRegistered(communication.TransportFastDDS) {
		commfastdds.RegisterNativeBus()
	}
	if !core.IsRegistered(communication.TransportROS2) {
		commros2.Register()
	}
}
