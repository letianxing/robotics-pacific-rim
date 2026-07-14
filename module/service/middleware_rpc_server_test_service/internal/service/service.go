package service

import (
	"context"

	commcore "github.com/pacific-rim/pacific-rim/infra/communication/go/core"
)

type Service struct {
	communication *commcore.CommunicationRuntime
}

func New(communication *commcore.CommunicationRuntime) *Service {
	return &Service{communication: communication}
}

func (s *Service) Run(ctx context.Context) error {
	<-ctx.Done()
	return ctx.Err()
}
