package core

import (
	"context"
	"fmt"
)

type BootstrapConfig struct {
	Communication ServiceCommunicationConfig `yaml:"communication"`
}

type CommunicationRuntime struct {
	Fabric     *Fabric
	ConfigPath string
}

func BootstrapCommunication(ctx context.Context, configPath string, serviceName string) (*CommunicationRuntime, error) {
	cfg, err := loadEffectiveBootstrapConfig(configPath)
	if err != nil {
		return nil, err
	}

	buses, pubsubRoutes, rpcRoutes, err := cfg.Communication.Build(serviceName)
	if err != nil {
		return nil, fmt.Errorf("build communication fabric: %w", err)
	}
	security, err := NewSecurityRuntime(cfg.Communication.Security)
	if err != nil {
		return nil, fmt.Errorf("build communication security: %w", err)
	}

	fabric, err := NewFabricWithSecurity(buses, pubsubRoutes, rpcRoutes, security)
	if err != nil {
		return nil, fmt.Errorf("create communication fabric: %w", err)
	}
	if err := fabric.ConnectAll(ctx); err != nil {
		_ = fabric.CloseAll(context.Background())
		return nil, fmt.Errorf("connect communication fabric: %w", err)
	}

	return &CommunicationRuntime{Fabric: fabric, ConfigPath: configPath}, nil
}

func (r *CommunicationRuntime) Close(ctx context.Context) error {
	if r == nil || r.Fabric == nil {
		return nil
	}
	return r.Fabric.CloseAll(ctx)
}
