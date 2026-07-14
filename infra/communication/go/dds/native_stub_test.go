//go:build !pacific_rim_cyclonedds

package dds

import (
	"context"
	"strings"
	"testing"
)

func TestNativeByteClientStubReportsBuildRequirement(t *testing.T) {
	client, err := NewNativeByteClient(DefaultConfig())
	if err != nil {
		t.Fatalf("NewNativeByteClient returned error: %v", err)
	}
	err = client.Connect(context.Background(), DefaultConfig())
	if err == nil {
		t.Fatal("expected native stub to report missing build tag")
	}
	if !strings.Contains(err.Error(), "pacific_rim_cyclonedds") {
		t.Fatalf("expected build tag guidance, got %v", err)
	}
}
